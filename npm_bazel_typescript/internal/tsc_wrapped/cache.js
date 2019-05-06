/**
 * @license
 * Copyright 2017 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "fs", "typescript", "./perf_trace"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const fs = require("fs");
    const ts = require("typescript");
    const perfTrace = require("./perf_trace");
    /**
     * Cache exposes a trivial LRU cache.
     *
     * This code uses the fact that JavaScript hash maps are linked lists - after
     * reaching the cache size limit, it deletes the oldest (first) entries. Used
     * cache entries are moved to the end of the list by deleting and re-inserting.
     */
    class Cache {
        constructor(name, debug) {
            this.name = name;
            this.debug = debug;
            this.map = new Map();
            this.stats = { reads: 0, hits: 0, evictions: 0 };
        }
        set(key, value) {
            this.map.set(key, value);
        }
        get(key, updateCache = true) {
            this.stats.reads++;
            const entry = this.map.get(key);
            if (updateCache) {
                if (entry) {
                    this.debug(this.name, 'cache hit:', key);
                    this.stats.hits++;
                    // Move an entry to the end of the cache by deleting and re-inserting
                    // it.
                    this.map.delete(key);
                    this.map.set(key, entry);
                }
                else {
                    this.debug(this.name, 'cache miss:', key);
                }
                this.traceStats();
            }
            return entry;
        }
        delete(key) {
            this.map.delete(key);
        }
        evict(unevictableKeys) {
            // Drop half the cache, the least recently used entry == the first entry.
            this.debug('Evicting from the', this.name, 'cache...');
            const originalSize = this.map.size;
            let numberKeysToDrop = originalSize / 2;
            if (numberKeysToDrop === 0) {
                return 0;
            }
            // Map keys are iterated in insertion order, since we reinsert on access
            // this is indeed a LRU strategy.
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/keys
            for (const key of this.map.keys()) {
                if (numberKeysToDrop === 0)
                    break;
                if (unevictableKeys && unevictableKeys.has(key))
                    continue;
                this.map.delete(key);
                numberKeysToDrop--;
            }
            const keysDropped = originalSize - this.map.size;
            this.stats.evictions += keysDropped;
            this.debug('Evicted', keysDropped, this.name, 'cache entries');
            this.traceStats();
            return keysDropped;
        }
        keys() {
            return this.map.keys();
        }
        resetStats() {
            this.stats = { hits: 0, reads: 0, evictions: 0 };
        }
        printStats() {
            let percentage;
            if (this.stats.reads === 0) {
                percentage = 100.00; // avoid "NaN %"
            }
            else {
                percentage = (this.stats.hits / this.stats.reads * 100).toFixed(2);
            }
            this.debug(`${this.name} cache stats: ${percentage}% hits`, this.stats);
        }
        traceStats() {
            // counters are rendered as stacked bar charts, so record cache
            // hits/misses rather than the 'reads' stat tracked in stats
            // so the chart makes sense.
            perfTrace.counter(`${this.name} cache hit rate`, {
                'hits': this.stats.hits,
                'misses': this.stats.reads - this.stats.hits,
            });
            perfTrace.counter(`${this.name} cache evictions`, {
                'evictions': this.stats.evictions,
            });
            perfTrace.counter(`${this.name} cache size`, {
                [`${this.name}s`]: this.map.size,
            });
        }
    }
    /**
     * Default memory size, beyond which we evict from the cache.
     */
    const DEFAULT_MAX_MEM_USAGE = 1024 * (1 << 20 /* 1 MB */);
    /**
     * FileCache is a trivial LRU cache for typescript-parsed bazel-output files.
     *
     * Cache entries include an opaque bazel-supplied digest to track staleness.
     * Expected digests must be set (using updateCache) before using the cache.
     */
    // TODO(martinprobst): Drop the <T> parameter, it's no longer used.
    class FileCache {
        constructor(debug) {
            this.debug = debug;
            this.fileCache = new Cache('file', this.debug);
            /**
             * FileCache does not know how to construct bazel's opaque digests. This
             * field caches the last (or current) compile run's digests, so that code
             * below knows what digest to assign to a newly loaded file.
             */
            this.lastDigests = new Map();
            /**
             * FileCache can enter a degenerate state, where all cache entries are pinned
             * by lastDigests, but the system is still out of memory. In that case, do not
             * attempt to free memory until lastDigests has changed.
             */
            this.cannotEvict = false;
            /**
             * Because we cannot measuse the cache memory footprint directly, we evict
             * when the process' total memory usage goes beyond this number.
             */
            this.maxMemoryUsage = DEFAULT_MAX_MEM_USAGE;
            /**
             * Returns whether the cache should free some memory.
             *
             * Defined as a property so it can be overridden in tests.
             */
            this.shouldFreeMemory = () => {
                return process.memoryUsage().heapUsed > this.maxMemoryUsage;
            };
        }
        setMaxCacheSize(maxCacheSize) {
            if (maxCacheSize < 0) {
                throw new Error(`FileCache max size is negative: ${maxCacheSize}`);
            }
            this.debug('Cache max size is', maxCacheSize >> 20, 'MB');
            this.maxMemoryUsage = maxCacheSize;
            this.maybeFreeMemory();
        }
        resetMaxCacheSize() {
            this.setMaxCacheSize(DEFAULT_MAX_MEM_USAGE);
        }
        updateCache(digests) {
            // TODO(martinprobst): drop the Object based version, it's just here for
            // backwards compatibility.
            if (!(digests instanceof Map)) {
                digests = new Map(Object.keys(digests).map((k) => [k, digests[k]]));
            }
            this.debug('updating digests:', digests);
            this.lastDigests = digests;
            this.cannotEvict = false;
            for (const [filePath, newDigest] of digests.entries()) {
                const entry = this.fileCache.get(filePath, /*updateCache=*/ false);
                if (entry && entry.digest !== newDigest) {
                    this.debug('dropping file cache entry for', filePath, 'digests', entry.digest, newDigest);
                    this.fileCache.delete(filePath);
                }
            }
        }
        getLastDigest(filePath) {
            const digest = this.lastDigests.get(filePath);
            if (!digest) {
                throw new Error(`missing input digest for ${filePath}.` +
                    `(only have ${Array.from(this.lastDigests.keys())})`);
            }
            return digest;
        }
        getCache(filePath) {
            const entry = this.fileCache.get(filePath);
            if (entry)
                return entry.value;
            return undefined;
        }
        putCache(filePath, entry) {
            const dropped = this.maybeFreeMemory();
            this.fileCache.set(filePath, entry);
            this.debug('Loaded file:', filePath, 'dropped', dropped, 'files');
        }
        /**
         * Returns true if the given filePath was reported as an input up front and
         * has a known cache digest. FileCache can only cache known files.
         */
        isKnownInput(filePath) {
            return this.lastDigests.has(filePath);
        }
        inCache(filePath) {
            return !!this.getCache(filePath);
        }
        resetStats() {
            this.fileCache.resetStats();
        }
        printStats() {
            this.fileCache.printStats();
        }
        traceStats() {
            this.fileCache.traceStats();
        }
        /**
         * Frees memory if required. Returns the number of dropped entries.
         */
        maybeFreeMemory() {
            if (!this.shouldFreeMemory() || this.cannotEvict) {
                return 0;
            }
            const dropped = this.fileCache.evict(this.lastDigests);
            if (dropped === 0) {
                // Freeing memory did not drop any cache entries, because all are pinned.
                // Stop evicting until the pinned list changes again. This prevents
                // degenerating into an O(n^2) situation where each file load iterates
                // through the list of all files, trying to evict cache keys in vain
                // because all are pinned.
                this.cannotEvict = true;
            }
            return dropped;
        }
        getFileCacheKeysForTest() {
            return Array.from(this.fileCache.keys());
        }
    }
    exports.FileCache = FileCache;
    /**
     * ProgramAndFileCache is a trivial LRU cache for typescript-parsed programs and
     * bazel-output files.
     *
     * Programs are evicted before source files because they have less reuse across
     * compilations.
     */
    class ProgramAndFileCache extends FileCache {
        constructor() {
            super(...arguments);
            this.programCache = new Cache('program', this.debug);
        }
        getProgram(target) {
            return this.programCache.get(target);
        }
        putProgram(target, program) {
            const dropped = this.maybeFreeMemory();
            this.programCache.set(target, program);
            this.debug('Loaded program:', target, 'dropped', dropped, 'entries');
        }
        resetStats() {
            super.resetStats();
            this.programCache.resetStats();
        }
        printStats() {
            super.printStats();
            this.programCache.printStats();
        }
        traceStats() {
            super.traceStats();
            this.programCache.traceStats();
        }
        maybeFreeMemory() {
            if (!this.shouldFreeMemory())
                return 0;
            const dropped = this.programCache.evict();
            if (dropped > 0)
                return dropped;
            return super.maybeFreeMemory();
        }
        getProgramCacheKeysForTest() {
            return Array.from(this.programCache.keys());
        }
    }
    exports.ProgramAndFileCache = ProgramAndFileCache;
    /**
     * Load a source file from disk, or possibly return a cached version.
     */
    class CachedFileLoader {
        // TODO(alexeagle): remove unused param after usages updated:
        // angular:packages/bazel/src/ngc-wrapped/index.ts
        constructor(cache, unused) {
            this.cache = cache;
            /** Total amount of time spent loading files, for the perf trace. */
            this.totalReadTimeMs = 0;
        }
        fileExists(filePath) {
            return this.cache.isKnownInput(filePath);
        }
        loadFile(fileName, filePath, langVer) {
            let sourceFile = this.cache.getCache(filePath);
            if (!sourceFile) {
                const readStart = Date.now();
                const sourceText = fs.readFileSync(filePath, 'utf8');
                sourceFile = ts.createSourceFile(fileName, sourceText, langVer, true);
                const entry = {
                    digest: this.cache.getLastDigest(filePath),
                    value: sourceFile
                };
                const readEnd = Date.now();
                this.cache.putCache(filePath, entry);
                this.totalReadTimeMs += readEnd - readStart;
                perfTrace.counter('file load time', {
                    'read': this.totalReadTimeMs,
                });
                perfTrace.snapshotMemoryUsage();
            }
            return sourceFile;
        }
    }
    exports.CachedFileLoader = CachedFileLoader;
    /** Load a source file from disk. */
    class UncachedFileLoader {
        fileExists(filePath) {
            return ts.sys.fileExists(filePath);
        }
        loadFile(fileName, filePath, langVer) {
            const sourceText = fs.readFileSync(filePath, 'utf8');
            return ts.createSourceFile(fileName, sourceText, langVer, true);
        }
    }
    exports.UncachedFileLoader = UncachedFileLoader;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzY193cmFwcGVkL2NhY2hlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7R0FlRzs7Ozs7Ozs7Ozs7O0lBRUgseUJBQXlCO0lBQ3pCLGlDQUFpQztJQUNqQywwQ0FBMEM7SUFVMUM7Ozs7OztPQU1HO0lBQ0gsTUFBTSxLQUFLO1FBSVQsWUFBb0IsSUFBWSxFQUFVLEtBQVk7WUFBbEMsU0FBSSxHQUFKLElBQUksQ0FBUTtZQUFVLFVBQUssR0FBTCxLQUFLLENBQU87WUFIOUMsUUFBRyxHQUFHLElBQUksR0FBRyxFQUFhLENBQUM7WUFDM0IsVUFBSyxHQUFlLEVBQUMsS0FBSyxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUMsQ0FBQztRQUVMLENBQUM7UUFFMUQsR0FBRyxDQUFDLEdBQVcsRUFBRSxLQUFRO1lBQ3ZCLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMzQixDQUFDO1FBRUQsR0FBRyxDQUFDLEdBQVcsRUFBRSxXQUFXLEdBQUcsSUFBSTtZQUNqQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBRW5CLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ2hDLElBQUksV0FBVyxFQUFFO2dCQUNmLElBQUksS0FBSyxFQUFFO29CQUNULElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUUsR0FBRyxDQUFDLENBQUM7b0JBQ3pDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7b0JBQ2xCLHFF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QUFDLGVBQWUsSUFBSSxPQUFPLEdBQUcsU0FBUyxDQUFDO2dCQUM1QyxTQUFTLENBQUMsT0FBTyxDQUFDLGdCQUFnQixFQUFFO29CQUNsQyxNQUFNLEVBQUUsSUFBSSxDQUFDLGVBQWU7aUJBQzdCLENBQUMsQ0FBQztnQkFDSCxTQUFTLENBQUMsbUJBQW1CLEVBQUUsQ0FBQzthQUNqQztZQUVELE9BQU8sVUFBVSxDQUFDO1FBQ3BCLENBQUM7S0FDRjtJQW5DRCw0Q0FtQ0M7SUFFRCxvQ0FBb0M7SUFDcEMsTUFBYSxrQkFBa0I7UUFDN0IsVUFBVSxDQUFDLFFBQWdCO1lBQ3pCLE9BQU8sRUFBRSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDckMsQ0FBQztRQUVELFFBQVEsQ0FBQyxRQUFnQixFQUFFLFFBQWdCLEVBQUUsT0FBd0I7WUFFbkUsTUFBTSxVQUFVLEdBQUcsRUFBRSxDQUFDLFlBQVksQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDckQsT0FBTyxFQUFFLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDbEUsQ0FBQztLQUNGO0lBVkQsZ0RBVUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgMjAxNyBUaGUgQmF6ZWwgQXV0aG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC5cbiAqXG4gKiBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICogeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICpcbiAqIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuICogICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuICpcbiAqIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAqIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiAqIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICogU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICogbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4gKi9cblxuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgdHMgZnJvbSAndHlwZXNjcmlwdCc7XG5pbXBvcnQgKiBhcyBwZXJmVHJhY2UgZnJvbSAnLi9wZXJmX3RyYWNlJztcblxudHlwZSBEZWJ1ZyA9ICguLi5tc2c6IEFycmF5PHt9PikgPT4gdm9pZDtcblxuaW50ZXJmYWNlIENhY2hlU3RhdHMge1xuICByZWFkczogbnVtYmVyO1xuICBoaXRzOiBudW1iZXI7XG4gIGV2aWN0aW9uczogbnVtYmVyO1xufVxuXG4vKipcbiAqIENhY2hlIGV4cG9zZXMgYSB0cml2aWFsIExSVSBjYWNoZS5cbiAqXG4gKiBUaGlzIGNvZGUgdXNlcyB0aGUgZmFjdCB0aGF0IEphdmFTY3JpcHQgaGFzaCBtYXBzIGFyZSBsaW5rZWQgbGlzdHMgLSBhZnRlclxuICogcmVhY2hpbmcgdGhlIGNhY2hlIHNpemUgbGltaXQsIGl0IGRlbGV0ZXMgdGhlIG9sZGVzdCAoZmlyc3QpIGVudHJpZXMuIFVzZWRcbiAqIGNhY2hlIGVudHJpZXMgYXJlIG1vdmVkIHRvIHRoZSBlbmQgb2YgdGhlIGxpc3QgYnkgZGVsZXRpbmcgYW5kIHJlLWluc2VydGluZy5cbiAqL1xuY2xhc3MgQ2FjaGU8VD4ge1xuICBwcml2YXRlIG1hcCA9IG5ldyBNYXA8c3RyaW5nLCBUPigpO1xuICBwcml2YXRlIHN0YXRzOiBDYWNoZVN0YXRzID0ge3JlYWRzOiAwLCBoaXRzOiAwLCBldmljdGlvbnM6IDB9O1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgbmFtZTogc3RyaW5nLCBwcml2YXRlIGRlYnVnOiBEZWJ1Zykge31cblxuICBzZXQoa2V5OiBzdHJpbmcsIHZhbHVlOiBUKSB7XG4gICAgdGhpcy5tYXAuc2V0KGtleSwgdmFsdWUpO1xuICB9XG5cbiAgZ2V0KGtleTogc3RyaW5nLCB1cGRhdGVDYWNoZSA9IHRydWUpOiBUfHVuZGVmaW5lZCB7XG4gICAgdGhpcy5zdGF0cy5yZWFkcysrO1xuXG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm1hcC5nZXQoa2V5KTtcbiAgICBpZiAodXBkYXRlQ2FjaGUpIHtcbiAgICAgIGlmIChlbnRyeSkge1xuICAgICAgICB0aGlzLmRlYnVnKHRoaXMubmFtZSwgJ2NhY2hlIGhpdDonLCBrZXkpO1xuICAgICAgICB0aGlzLnN0YXRzLmhpdHMrKztcbiAgICAgICAgLy8gTW92ZSBhbiBlbnRyeSB0byB0aGUgZW5kIG9mIHRoZSBjYWNoZSBieSBkZWxldGluZyBhbmQgcmUtaW5zZXJ0aW5nXG4gICAgICAgIC8vIGl0LlxuICAgICAgICB0aGlzLm1hcC5kZWxldGUoa2V5KTtcbiAgICAgICAgdGhpcy5tYXAuc2V0KGtleSwgZW50cnkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5kZWJ1Zyh0aGlzLm5hbWUsICdjYWNoZSBtaXNzOicsIGtleSk7XG4gICAgICB9XG4gICAgICB0aGlzLnRyYWNlU3RhdHMoKTtcbiAgICB9XG4gICAgcmV0dXJuIGVudHJ5O1xuICB9XG5cbiAgZGVsZXRlKGtleTogc3RyaW5nKSB7XG4gICAgdGhpcy5tYXAuZGVsZXRlKGtleSk7XG4gIH1cblxuICBldmljdCh1bmV2aWN0YWJsZUtleXM/OiB7aGFzOiAoa2V5OiBzdHJpbmcpID0+IGJvb2xlYW59KTogbnVtYmVyIHtcbiAgICAvLyBEcm9wIGhhbGYgdGhlIGNhY2hlLCB0aGUgbGVhc3QgcmVjZW50bHkgdXNlZCBlbnRyeSA9PSB0aGUgZmlyc3QgZW50cnkuXG4gICAgdGhpcy5kZWJ1ZygnRXZpY3RpbmcgZnJvbSB0aGUnLCB0aGlzLm5hbWUsICdjYWNoZS4uLicpO1xuICAgIGNvbnN0IG9yaWdpbmFsU2l6ZSA9IHRoaXMubWFwLnNpemU7XG4gICAgbGV0IG51bWJlcktleXNUb0Ryb3AgPSBvcmlnaW5hbFNpemUgLyAyO1xuICAgIGlmIChudW1iZXJLZXlzVG9Ecm9wID09PSAwKSB7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgLy8gTWFwIGtleXMgYXJlIGl0ZXJhdGVkIGluIGluc2VydGlvbiBvcmRlciwgc2luY2Ugd2UgcmVpbnNlcnQgb24gYWNjZXNzXG4gICAgLy8gdGhpcyBpcyBpbmRlZWQgYSBMUlUgc3RyYXRlZ3kuXG4gICAgLy8gaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvSmF2YVNjcmlwdC9SZWZlcmVuY2UvR2xvYmFsX09iamVjdHMvTWFwL2tleXNcbiAgICBmb3IgKGNvbnN0IGtleSBvZiB0aGlzLm1hcC5rZXlzKCkpIHtcbiAgICAgIGlmIChudW1iZXJLZXlzVG9Ecm9wID09PSAwKSBicmVhaztcbiAgICAgIGlmICh1bmV2aWN0YWJsZUtleXMgJiYgdW5ldmljdGFibGVLZXlzLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgIHRoaXMubWFwLmRlbGV0ZShrZXkpO1xuICAgICAgbnVtYmVyS2V5c1RvRHJvcC0tO1xuICAgIH1cbiAgICBjb25zdCBrZXlzRHJvcHBlZCA9IG9yaWdpbmFsU2l6ZSAtIHRoaXMubWFwLnNpemU7XG4gICAgdGhpcy5zdGF0cy5ldmljdGlvbnMgKz0ga2V5c0Ryb3BwZWQ7XG4gICAgdGhpcy5kZWJ1ZygnRXZpY3RlZCcsIGtleXNEcm9wcGVkLCB0aGlzLm5hbWUsICdjYWNoZSBlbnRyaWVzJyk7XG4gICAgdGhpcy50cmFjZVN0YXRzKCk7XG4gICAgcmV0dXJuIGtleXNEcm9wcGVkO1xuICB9XG5cbiAga2V5cygpIHtcbiAgICByZXR1cm4gdGhpcy5tYXAua2V5cygpO1xuICB9XG5cbiAgcmVzZXRTdGF0cygpIHtcbiAgICB0aGlzLnN0YXRzID0ge2hpdHM6IDAsIHJlYWRzOiAwLCBldmljdGlvbnM6IDB9O1xuICB9XG5cbiAgcHJpbnRTdGF0cygpIHtcbiAgICBsZXQgcGVyY2VudGFnZTtcbiAgICBpZiAodGhpcy5zdGF0cy5yZWFkcyA9PT0gMCkge1xuICAgICAgcGVyY2VudGFnZSA9IDEwMC4wMDsgIC8vIGF2b2lkIFwiTmFOICVcIlxuICAgIH0gZWxzZSB7XG4gICAgICBwZXJjZW50YWdlID0gKHRoaXMuc3RhdHMuaGl0cyAvIHRoaXMuc3RhdHMucmVhZHMgKiAxMDApLnRvRml4ZWQoMik7XG4gICAgfVxuICAgIHRoaXMuZGVidWcoYCR7dGhpcy5uYW1lfSBjYWNoZSBzdGF0czogJHtwZXJjZW50YWdlfSUgaGl0c2AsIHRoaXMuc3RhdHMpO1xuICB9XG5cbiAgdHJhY2VTdGF0cygpIHtcbiAgICAvLyBjb3VudGVycyBhcmUgcmVuZGVyZWQgYXMgc3RhY2tlZCBiYXIgY2hhcnRzLCBzbyByZWNvcmQgY2FjaGVcbiAgICAvLyBoaXRzL21pc3NlcyByYXRoZXIgdGhhbiB0aGUgJ3JlYWRzJyBzdGF0IHRyYWNrZWQgaW4gc3RhdHNcbiAgICAvLyBzbyB0aGUgY2hhcnQgbWFrZXMgc2Vuc2UuXG4gICAgcGVyZlRyYWNlLmNvdW50ZXIoYCR7dGhpcy5uYW1lfSBjYWNoZSBoaXQgcmF0ZWAsIHtcbiAgICAgICdoaXRzJzogdGhpcy5zdGF0cy5oaXRzLFxuICAgICAgJ21pc3Nlcyc6IHRoaXMuc3RhdHMucmVhZHMgLSB0aGlzLnN0YXRzLmhpdHMsXG4gICAgfSk7XG4gICAgcGVyZlRyYWNlLmNvdW50ZXIoYCR7dGhpcy5uYW1lfSBjYWNoZSBldmljdGlvbnNgLCB7XG4gICAgICAnZXZpY3Rpb25zJzogdGhpcy5zdGF0cy5ldmljdGlvbnMsXG4gICAgfSk7XG4gICAgcGVyZlRyYWNlLmNvdW50ZXIoYCR7dGhpcy5uYW1lfSBjYWNoZSBzaXplYCwge1xuICAgICAgW2Ake3RoaXMubmFtZX1zYF06IHRoaXMubWFwLnNpemUsXG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBTb3VyY2VGaWxlRW50cnkge1xuICBkaWdlc3Q6IHN0cmluZzsgIC8vIGJsYXplJ3Mgb3BhcXVlIGRpZ2VzdCBvZiB0aGUgZmlsZVxuICB2YWx1ZTogdHMuU291cmNlRmlsZTtcbn1cblxuLyoqXG4gKiBEZWZhdWx0IG1lbW9yeSBzaXplLCBiZXlvbmQgd2hpY2ggd2UgZXZpY3QgZnJvbSB0aGUgY2FjaGUuXG4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX01FTV9VU0FHRSA9IDEwMjQgKiAoMSA8PCAyMCAvKiAxIE1CICovKTtcblxuLyoqXG4gKiBGaWxlQ2FjaGUgaXMgYSB0cml2aWFsIExSVSBjYWNoZSBmb3IgdHlwZXNjcmlwdC1wYXJzZWQgYmF6ZWwtb3V0cHV0IGZpbGVzLlxuICpcbiAqIENhY2hlIGVudHJpZXMgaW5jbHVkZSBhbiBvcGFxdWUgYmF6ZWwtc3VwcGxpZWQgZGlnZXN0IHRvIHRyYWNrIHN0YWxlbmVzcy5cbiAqIEV4cGVjdGVkIGRpZ2VzdHMgbXVzdCBiZSBzZXQgKHVzaW5nIHVwZGF0ZUNhY2hlKSBiZWZvcmUgdXNpbmcgdGhlIGNhY2hlLlxuICovXG4vLyBUT0RPKG1hcnRpbnByb2JzdCk6IERyb3AgdGhlIDxUPiBwYXJhbWV0ZXIsIGl0J3Mgbm8gbG9uZ2VyIHVzZWQuXG5leHBvcnQgY2xhc3MgRmlsZUNhY2hlPFQgPSB7fT4ge1xuICBwcml2YXRlIGZpbGVDYWNoZSA9IG5ldyBDYWNoZTxTb3VyY2VGaWxlRW50cnk+KCdmaWxlJywgdGhpcy5kZWJ1Zyk7XG4gIC8qKlxuICAgKiBGaWxlQ2FjaGUgZG9lcyBub3Qga25vdyBob3cgdG8gY29uc3RydWN0IGJhemVsJ3Mgb3BhcXVlIGRpZ2VzdHMuIFRoaXNcbiAgICogZmllbGQgY2FjaGVzIHRoZSBsYXN0IChvciBjdXJyZW50KSBjb21waWxlIHJ1bidzIGRpZ2VzdHMsIHNvIHRoYXQgY29kZVxuICAgKiBiZWxvdyBrbm93cyB3aGF0IGRpZ2VzdCB0byBhc3NpZ24gdG8gYSBuZXdseSBsb2FkZWQgZmlsZS5cbiAgICovXG4gIHByaXZhdGUgbGFzdERpZ2VzdHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKipcbiAgICogRmlsZUNhY2hlIGNhbiBlbnRlciBhIGRlZ2VuZXJhdGUgc3RhdGUsIHdoZXJlIGFsbCBjYWNoZSBlbnRyaWVzIGFyZSBwaW5uZWRcbiAgICogYnkgbGFzdERpZ2VzdHMsIGJ1dCB0aGUgc3lzdGVtIGlzIHN0aWxsIG91dCBvZiBtZW1vcnkuIEluIHRoYXQgY2FzZSwgZG8gbm90XG4gICAqIGF0dGVtcHQgdG8gZnJlZSBtZW1vcnkgdW50aWwgbGFzdERpZ2VzdHMgaGFzIGNoYW5nZWQuXG4gICAqL1xuICBwcml2YXRlIGNhbm5vdEV2aWN0ID0gZmFsc2U7XG5cbiAgLyoqXG4gICAqIEJlY2F1c2Ugd2UgY2Fubm90IG1lYXN1c2UgdGhlIGNhY2hlIG1lbW9yeSBmb290cHJpbnQgZGlyZWN0bHksIHdlIGV2aWN0XG4gICAqIHdoZW4gdGhlIHByb2Nlc3MnIHRvdGFsIG1lbW9yeSB1c2FnZSBnb2VzIGJleW9uZCB0aGlzIG51bWJlci5cbiAgICovXG4gIHByaXZhdGUgbWF4TWVtb3J5VXNhZ2UgPSBERUZBVUxUX01BWF9NRU1fVVNBR0U7XG5cbiAgY29uc3RydWN0b3IocHJvdGVjdGVkIGRlYnVnOiAoLi4ubXNnOiBBcnJheTx7fT4pID0+IHZvaWQpIHt9XG5cbiAgc2V0TWF4Q2FjaGVTaXplKG1heENhY2hlU2l6ZTogbnVtYmVyKSB7XG4gICAgaWYgKG1heENhY2hlU2l6ZSA8IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRmlsZUNhY2hlIG1heCBzaXplIGlzIG5lZ2F0aXZlOiAke21heENhY2hlU2l6ZX1gKTtcbiAgICB9XG4gICAgdGhpcy5kZWJ1ZygnQ2FjaGUgbWF4IHNpemUgaXMnLCBtYXhDYWNoZVNpemUgPj4gMjAsICdNQicpO1xuICAgIHRoaXMubWF4TWVtb3J5VXNhZ2UgPSBtYXhDYWNoZVNpemU7XG4gICAgdGhpcy5tYXliZUZyZWVNZW1vcnkoKTtcbiAgfVxuXG4gIHJlc2V0TWF4Q2FjaGVTaXplKCkge1xuICAgIHRoaXMuc2V0TWF4Q2FjaGVTaXplKERFRkFVTFRfTUFYX01FTV9VU0FHRSk7XG4gIH1cblxuICAvKipcbiAgICogVXBkYXRlcyB0aGUgY2FjaGUgd2l0aCB0aGUgZ2l2ZW4gZGlnZXN0cy5cbiAgICpcbiAgICogdXBkYXRlQ2FjaGUgbXVzdCBiZSBjYWxsZWQgYmVmb3JlIGxvYWRpbmcgZmlsZXMgLSBvbmx5IGZpbGVzIHRoYXQgd2VyZVxuICAgKiB1cGRhdGVkICh3aXRoIGEgZGlnZXN0KSBwcmV2aW91c2x5IGNhbiBiZSBsb2FkZWQuXG4gICAqL1xuICB1cGRhdGVDYWNoZShkaWdlc3RzOiB7W2s6IHN0cmluZ106IHN0cmluZ30pOiB2b2lkO1xuICB1cGRhdGVDYWNoZShkaWdlc3RzOiBNYXA8c3RyaW5nLCBzdHJpbmc+KTogdm9pZDtcbiAgdXBkYXRlQ2FjaGUoZGlnZXN0czogTWFwPHN0cmluZywgc3RyaW5nPnx7W2s6IHN0cmluZ106IHN0cmluZ30pIHtcbiAgICAvLyBUT0RPKG1hcnRpbnByb2JzdCk6IGRyb3AgdGhlIE9iamVjdCBiYXNlZCB2ZXJzaW9uLCBpdCdzIGp1c3QgaGVyZSBmb3JcbiAgICAvLyBiYWNrd2FyZHMgY29tcGF0aWJpbGl0eS5cbiAgICBpZiAoIShkaWdlc3RzIGluc3RhbmNlb2YgTWFwKSkge1xuICAgICAgZGlnZXN0cyA9IG5ldyBNYXAoT2JqZWN0LmtleXMoZGlnZXN0cykubWFwKFxuICAgICAgICAgIChrKTogW3N0cmluZywgc3RyaW5nXSA9PiBbaywgKGRpZ2VzdHMgYXMge1trOiBzdHJpbmddOiBzdHJpbmd9KVtrXV0pKTtcbiAgICB9XG4gICAgdGhpcy5kZWJ1ZygndXBkYXRpbmcgZGlnZXN0czonLCBkaWdlc3RzKTtcbiAgICB0aGlzLmxhc3REaWdlc3RzID0gZGlnZXN0cztcbiAgICB0aGlzLmNhbm5vdEV2aWN0ID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBbZmlsZVBhdGgsIG5ld0RpZ2VzdF0gb2YgZGlnZXN0cy5lbnRyaWVzKCkpIHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5maWxlQ2FjaGUuZ2V0KGZpbGVQYXRoLCAvKnVwZGF0ZUNhY2hlPSovIGZhbHNlKTtcbiAgICAgIGlmIChlbnRyeSAmJiBlbnRyeS5kaWdlc3QgIT09IG5ld0RpZ2VzdCkge1xuICAgICAgICB0aGlzLmRlYnVnKFxuICAgICAgICAgICAgJ2Ryb3BwaW5nIGZpbGUgY2FjaGUgZW50cnkgZm9yJywgZmlsZVBhdGgsICdkaWdlc3RzJywgZW50cnkuZGlnZXN0LFxuICAgICAgICAgICAgbmV3RGlnZXN0KTtcbiAgICAgICAgdGhpcy5maWxlQ2FjaGUuZGVsZXRlKGZpbGVQYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBnZXRMYXN0RGlnZXN0KGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGRpZ2VzdCA9IHRoaXMubGFzdERpZ2VzdHMuZ2V0KGZpbGVQYXRoKTtcbiAgICBpZiAoIWRpZ2VzdCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtaXNzaW5nIGlucHV0IGRpZ2VzdCBmb3IgJHtmaWxlUGF0aH0uYCArXG4gICAgICAgICAgYChvbmx5IGhhdmUgJHtBcnJheS5mcm9tKHRoaXMubGFzdERpZ2VzdHMua2V5cygpKX0pYCk7XG4gICAgfVxuICAgIHJldHVybiBkaWdlc3Q7XG4gIH1cblxuICBnZXRDYWNoZShmaWxlUGF0aDogc3RyaW5nKTogdHMuU291cmNlRmlsZXx1bmRlZmluZWQge1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5maWxlQ2FjaGUuZ2V0KGZpbGVQYXRoKTtcbiAgICBpZiAoZW50cnkpIHJldHVybiBlbnRyeS52YWx1ZTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgcHV0Q2FjaGUoZmlsZVBhdGg6IHN0cmluZywgZW50cnk6IFNvdXJjZUZpbGVFbnRyeSk6IHZvaWQge1xuICAgIGNvbnN0IGRyb3BwZWQgPSB0aGlzLm1heWJlRnJlZU1lbW9yeSgpO1xuICAgIHRoaXMuZmlsZUNhY2hlLnNldChmaWxlUGF0aCwgZW50cnkpO1xuICAgIHRoaXMuZGVidWcoJ0xvYWRlZCBmaWxlOicsIGZpbGVQYXRoLCAnZHJvcHBlZCcsIGRyb3BwZWQsICdmaWxlcycpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgZ2l2ZW4gZmlsZVBhdGggd2FzIHJlcG9ydGVkIGFzIGFuIGlucHV0IHVwIGZyb250IGFuZFxuICAgKiBoYXMgYSBrbm93biBjYWNoZSBkaWdlc3QuIEZpbGVDYWNoZSBjYW4gb25seSBjYWNoZSBrbm93biBmaWxlcy5cbiAgICovXG4gIGlzS25vd25JbnB1dChmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMubGFzdERpZ2VzdHMuaGFzKGZpbGVQYXRoKTtcbiAgfVxuXG4gIGluQ2FjaGUoZmlsZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAhIXRoaXMuZ2V0Q2FjaGUoZmlsZVBhdGgpO1xuICB9XG5cbiAgcmVzZXRTdGF0cygpIHtcbiAgICB0aGlzLmZpbGVDYWNoZS5yZXNldFN0YXRzKCk7XG4gIH1cblxuICBwcmludFN0YXRzKCkge1xuICAgIHRoaXMuZmlsZUNhY2hlLnByaW50U3RhdHMoKTtcbiAgfVxuXG4gIHRyYWNlU3RhdHMoKSB7XG4gICAgdGhpcy5maWxlQ2FjaGUudHJhY2VTdGF0cygpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgd2hldGhlciB0aGUgY2FjaGUgc2hvdWxkIGZyZWUgc29tZSBtZW1vcnkuXG4gICAqXG4gICAqIERlZmluZWQgYXMgYSBwcm9wZXJ0eSBzbyBpdCBjYW4gYmUgb3ZlcnJpZGRlbiBpbiB0ZXN0cy5cbiAgICovXG4gIHNob3VsZEZyZWVNZW1vcnk6ICgpID0+IGJvb2xlYW4gPSAoKSA9PiB7XG4gICAgcmV0dXJuIHByb2Nlc3MubWVtb3J5VXNhZ2UoKS5oZWFwVXNlZCA+IHRoaXMubWF4TWVtb3J5VXNhZ2U7XG4gIH07XG5cbiAgLyoqXG4gICAqIEZyZWVzIG1lbW9yeSBpZiByZXF1aXJlZC4gUmV0dXJucyB0aGUgbnVtYmVyIG9mIGRyb3BwZWQgZW50cmllcy5cbiAgICovXG4gIG1heWJlRnJlZU1lbW9yeSgpIHtcbiAgICBpZiAoIXRoaXMuc2hvdWxkRnJlZU1lbW9yeSgpIHx8IHRoaXMuY2Fubm90RXZpY3QpIHtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBjb25zdCBkcm9wcGVkID0gdGhpcy5maWxlQ2FjaGUuZXZpY3QodGhpcy5sYXN0RGlnZXN0cyk7XG4gICAgaWYgKGRyb3BwZWQgPT09IDApIHtcbiAgICAgIC8vIEZyZWVpbmcgbWVtb3J5IGRpZCBub3QgZHJvcCBhbnkgY2FjaGUgZW50cmllcywgYmVjYXVzZSBhbGwgYXJlIHBpbm5lZC5cbiAgICAgIC8vIFN0b3AgZXZpY3RpbmcgdW50aWwgdGhlIHBpbm5lZCBsaXN0IGNoYW5nZXMgYWdhaW4uIFRoaXMgcHJldmVudHNcbiAgICAgIC8vIGRlZ2VuZXJhdGluZyBpbnRvIGFuIE8obl4yKSBzaXR1YXRpb24gd2hlcmUgZWFjaCBmaWxlIGxvYWQgaXRlcmF0ZXNcbiAgICAgIC8vIHRocm91Z2ggdGhlIGxpc3Qgb2YgYWxsIGZpbGVzLCB0cnlpbmcgdG8gZXZpY3QgY2FjaGUga2V5cyBpbiB2YWluXG4gICAgICAvLyBiZWNhdXNlIGFsbCBhcmUgcGlubmVkLlxuICAgICAgdGhpcy5jYW5ub3RFdmljdCA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiBkcm9wcGVkO1xuICB9XG5cbiAgZ2V0RmlsZUNhY2hlS2V5c0ZvclRlc3QoKSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20odGhpcy5maWxlQ2FjaGUua2V5cygpKTtcbiAgfVxufVxuXG4vKipcbiAqIFByb2dyYW1BbmRGaWxlQ2FjaGUgaXMgYSB0cml2aWFsIExSVSBjYWNoZSBmb3IgdHlwZXNjcmlwdC1wYXJzZWQgcHJvZ3JhbXMgYW5kXG4gKiBiYXplbC1vdXRwdXQgZmlsZXMuXG4gKlxuICogUHJvZ3JhbXMgYXJlIGV2aWN0ZWQgYmVmb3JlIHNvdXJjZSBmaWxlcyBiZWNhdXNlIHRoZXkgaGF2ZSBsZXNzIHJldXNlIGFjcm9zc1xuICogY29tcGlsYXRpb25zLlxuICovXG5leHBvcnQgY2xhc3MgUHJvZ3JhbUFuZEZpbGVDYWNoZSBleHRlbmRzIEZpbGVDYWNoZSB7XG4gIHByaXZhdGUgcHJvZ3JhbUNhY2hlID0gbmV3IENhY2hlPHRzLlByb2dyYW0+KCdwcm9ncmFtJywgdGhpcy5kZWJ1Zyk7XG5cbiAgZ2V0UHJvZ3JhbSh0YXJnZXQ6IHN0cmluZyk6IHRzLlByb2dyYW18dW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5wcm9ncmFtQ2FjaGUuZ2V0KHRhcmdldCk7XG4gIH1cblxuICBwdXRQcm9ncmFtKHRhcmdldDogc3RyaW5nLCBwcm9ncmFtOiB0cy5Qcm9ncmFtKTogdm9pZCB7XG4gICAgY29uc3QgZHJvcHBlZCA9IHRoaXMubWF5YmVGcmVlTWVtb3J5KCk7XG4gICAgdGhpcy5wcm9ncmFtQ2FjaGUuc2V0KHRhcmdldCwgcHJvZ3JhbSk7XG4gICAgdGhpcy5kZWJ1ZygnTG9hZGVkIHByb2dyYW06JywgdGFyZ2V0LCAnZHJvcHBlZCcsIGRyb3BwZWQsICdlbnRyaWVzJyk7XG4gIH1cblxuICByZXNldFN0YXRzKCkge1xuICAgIHN1cGVyLnJlc2V0U3RhdHMoKVxuICAgIHRoaXMucHJvZ3JhbUNhY2hlLnJlc2V0U3RhdHMoKTtcbiAgfVxuXG4gIHByaW50U3RhdHMoKSB7XG4gICAgc3VwZXIucHJpbnRTdGF0cygpO1xuICAgIHRoaXMucHJvZ3JhbUNhY2hlLnByaW50U3RhdHMoKTtcbiAgfVxuXG4gIHRyYWNlU3RhdHMoKSB7XG4gICAgc3VwZXIudHJhY2VTdGF0cygpO1xuICAgIHRoaXMucHJvZ3JhbUNhY2hlLnRyYWNlU3RhdHMoKTtcbiAgfVxuXG4gIG1heWJlRnJlZU1lbW9yeSgpIHtcbiAgICBpZiAoIXRoaXMuc2hvdWxkRnJlZU1lbW9yeSgpKSByZXR1cm4gMDtcblxuICAgIGNvbnN0IGRyb3BwZWQgPSB0aGlzLnByb2dyYW1DYWNoZS5ldmljdCgpO1xuICAgIGlmIChkcm9wcGVkID4gMCkgcmV0dXJuIGRyb3BwZWQ7XG5cbiAgICByZXR1cm4gc3VwZXIubWF5YmVGcmVlTWVtb3J5KCk7XG4gIH1cblxuICBnZXRQcm9ncmFtQ2FjaGVLZXlzRm9yVGVzdCgpIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnByb2dyYW1DYWNoZS5rZXlzKCkpO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZUxvYWRlciB7XG4gIGxvYWRGaWxlKGZpbGVOYW1lOiBzdHJpbmcsIGZpbGVQYXRoOiBzdHJpbmcsIGxhbmdWZXI6IHRzLlNjcmlwdFRhcmdldCk6XG4gICAgICB0cy5Tb3VyY2VGaWxlO1xuICBmaWxlRXhpc3RzKGZpbGVQYXRoOiBzdHJpbmcpOiBib29sZWFuO1xufVxuXG4vKipcbiAqIExvYWQgYSBzb3VyY2UgZmlsZSBmcm9tIGRpc2ssIG9yIHBvc3NpYmx5IHJldHVybiBhIGNhY2hlZCB2ZXJzaW9uLlxuICovXG5leHBvcnQgY2xhc3MgQ2FjaGVkRmlsZUxvYWRlciBpbXBsZW1lbnRzIEZpbGVMb2FkZXIge1xuICAvKiogVG90YWwgYW1vdW50IG9mIHRpbWUgc3BlbnQgbG9hZGluZyBmaWxlcywgZm9yIHRoZSBwZXJmIHRyYWNlLiAqL1xuICBwcml2YXRlIHRvdGFsUmVhZFRpbWVNcyA9IDA7XG5cbiAgLy8gVE9ETyhhbGV4ZWFnbGUpOiByZW1vdmUgdW51c2VkIHBhcmFtIGFmdGVyIHVzYWdlcyB1cGRhdGVkOlxuICAvLyBhbmd1bGFyOnBhY2thZ2VzL2JhemVsL3NyYy9uZ2Mtd3JhcHBlZC9pbmRleC50c1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGNhY2hlOiBGaWxlQ2FjaGUsIHVudXNlZD86IGJvb2xlYW4pIHt9XG5cbiAgZmlsZUV4aXN0cyhmaWxlUGF0aDogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuY2FjaGUuaXNLbm93bklucHV0KGZpbGVQYXRoKTtcbiAgfVxuXG4gIGxvYWRGaWxlKGZpbGVOYW1lOiBzdHJpbmcsIGZpbGVQYXRoOiBzdHJpbmcsIGxhbmdWZXI6IHRzLlNjcmlwdFRhcmdldCk6XG4gICAgICB0cy5Tb3VyY2VGaWxlIHtcbiAgICBsZXQgc291cmNlRmlsZSA9IHRoaXMuY2FjaGUuZ2V0Q2FjaGUoZmlsZVBhdGgpO1xuICAgIGlmICghc291cmNlRmlsZSkge1xuICAgICAgY29uc3QgcmVhZFN0YXJ0ID0gRGF0ZS5ub3coKTtcbiAgICAgIGNvbnN0IHNvdXJjZVRleHQgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGY4Jyk7XG4gICAgICBzb3VyY2VGaWxlID0gdHMuY3JlYXRlU291cmNlRmlsZShmaWxlTmFtZSwgc291cmNlVGV4dCwgbGFuZ1ZlciwgdHJ1ZSk7XG4gICAgICBjb25zdCBlbnRyeSA9IHtcbiAgICAgICAgZGlnZXN0OiB0aGlzLmNhY2hlLmdldExhc3REaWdlc3QoZmlsZVBhdGgpLFxuICAgICAgICB2YWx1ZTogc291cmNlRmlsZVxuICAgICAgfTtcbiAgICAgIGNvbnN0IHJlYWRFbmQgPSBEYXRlLm5vdygpO1xuICAgICAgdGhpcy5jYWNoZS5wdXRDYWNoZShmaWxlUGF0aCwgZW50cnkpO1xuXG4gICAgICB0aGlzLnRvdGFsUmVhZFRpbWVNcyArPSByZWFkRW5kIC0gcmVhZFN0YXJ0O1xuICAgICAgcGVyZlRyYWNlLmNvdW50ZXIoJ2ZpbGUgbG9hZCB0aW1lJywge1xuICAgICAgICAncmVhZCc6IHRoaXMudG90YWxSZWFkVGltZU1zLFxuICAgICAgfSk7XG4gICAgICBwZXJmVHJhY2Uuc25hcHNob3RNZW1vcnlVc2FnZSgpO1xuICAgIH1cblxuICAgIHJldHVybiBzb3VyY2VGaWxlO1xuICB9XG59XG5cbi8qKiBMb2FkIGEgc291cmNlIGZpbGUgZnJvbSBkaXNrLiAqL1xuZXhwb3J0IGNsYXNzIFVuY2FjaGVkRmlsZUxvYWRlciBpbXBsZW1lbnRzIEZpbGVMb2FkZXIge1xuICBmaWxlRXhpc3RzKGZpbGVQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdHMuc3lzLmZpbGVFeGlzdHMoZmlsZVBhdGgpO1xuICB9XG5cbiAgbG9hZEZpbGUoZmlsZU5hbWU6IHN0cmluZywgZmlsZVBhdGg6IHN0cmluZywgbGFuZ1ZlcjogdHMuU2NyaXB0VGFyZ2V0KTpcbiAgICAgIHRzLlNvdXJjZUZpbGUge1xuICAgIGNvbnN0IHNvdXJjZVRleHQgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGY4Jyk7XG4gICAgcmV0dXJuIHRzLmNyZWF0ZVNvdXJjZUZpbGUoZmlsZU5hbWUsIHNvdXJjZVRleHQsIGxhbmdWZXIsIHRydWUpO1xuICB9XG59XG4iXX0=