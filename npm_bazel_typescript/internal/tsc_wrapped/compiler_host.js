(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "fs", "path", "typescript", "./perf_trace", "./worker"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const fs = require("fs");
    const path = require("path");
    const ts = require("typescript");
    const perfTrace = require("./perf_trace");
    const worker_1 = require("./worker");
    function narrowTsOptions(options) {
        if (!options.rootDirs) {
            throw new Error(`compilerOptions.rootDirs should be set by tsconfig.bzl`);
        }
        if (!options.rootDir) {
            throw new Error(`compilerOptions.rootDir should be set by tsconfig.bzl`);
        }
        if (!options.outDir) {
            throw new Error(`compilerOptions.outDir should be set by tsconfig.bzl`);
        }
        return options;
    }
    exports.narrowTsOptions = narrowTsOptions;
    function validateBazelOptions(bazelOpts) {
        if (!bazelOpts.isJsTranspilation)
            return;
        if (bazelOpts.compilationTargetSrc &&
            bazelOpts.compilationTargetSrc.length > 1) {
            throw new Error('In JS transpilation mode, only one file can appear in ' +
                'bazelOptions.compilationTargetSrc.');
        }
        if (!bazelOpts.transpiledJsOutputFileName &&
            !bazelOpts.transpiledJsOutputDirectory) {
            throw new Error('In JS transpilation mode, either transpiledJsOutputFileName or ' +
                'transpiledJsOutputDirectory must be specified in tsconfig.');
        }
        if (bazelOpts.transpiledJsOutputFileName &&
            bazelOpts.transpiledJsOutputDirectory) {
            throw new Error('In JS transpilation mode, cannot set both ' +
                'transpiledJsOutputFileName and transpiledJsOutputDirectory.');
        }
    }
    const SOURCE_EXT = /((\.d)?\.tsx?|\.js)$/;
    /**
     * CompilerHost that knows how to cache parsed files to improve compile times.
     */
    class CompilerHost {
        constructor(inputFiles, options, bazelOpts, delegate, fileLoader, moduleResolver = ts.resolveModuleName) {
            this.inputFiles = inputFiles;
            this.bazelOpts = bazelOpts;
            this.delegate = delegate;
            this.fileLoader = fileLoader;
            this.moduleResolver = moduleResolver;
            /**
             * Lookup table to answer file stat's without looking on disk.
             */
            this.knownFiles = new Set();
            this.moduleResolutionHost = this;
            // TODO(evanm): delete this once tsickle is updated.
            this.host = this;
            this.allowActionInputReads = true;
            this.options = narrowTsOptions(options);
            this.relativeRoots =
                this.options.rootDirs.map(r => path.relative(this.options.rootDir, r));
            inputFiles.forEach((f) => {
                this.knownFiles.add(f);
            });
            // getCancelationToken is an optional method on the delegate. If we
            // unconditionally implement the method, we will be forced to return null,
            // in the absense of the delegate method. That won't match the return type.
            // Instead, we optionally set a function to a field with the same name.
            if (delegate && delegate.getCancellationToken) {
                this.getCancelationToken = delegate.getCancellationToken.bind(delegate);
            }
            // Override directoryExists so that TypeScript can automatically
            // include global typings from node_modules/@types
            // see getAutomaticTypeDirectiveNames in
            // TypeScript:src/compiler/moduleNameResolver
            if (this.allowActionInputReads && delegate && delegate.directoryExists) {
                this.directoryExists = delegate.directoryExists.bind(delegate);
            }
            validateBazelOptions(bazelOpts);
            this.googmodule = bazelOpts.googmodule;
            this.es5Mode = bazelOpts.es5Mode;
            this.prelude = bazelOpts.prelude;
            this.untyped = bazelOpts.untyped;
            this.typeBlackListPaths = new Set(bazelOpts.typeBlackListPaths);
            this.transformDecorators = bazelOpts.tsickle;
            this.transformTypesToClosure = bazelOpts.tsickle;
            this.addDtsClutzAliases = bazelOpts.addDtsClutzAliases;
            this.isJsTranspilation = Boolean(bazelOpts.isJsTranspilation);
            this.provideExternalModuleDtsNamespace = !bazelOpts.hasImplementation;
        }
        /**
         * For the given potentially absolute input file path (typically .ts), returns
         * the relative output path. For example, for
         * /path/to/root/blaze-out/k8-fastbuild/genfiles/my/file.ts, will return
         * my/file.js or my/file.closure.js (depending on ES5 mode).
         */
        relativeOutputPath(fileName) {
            let result = this.rootDirsRelative(fileName);
            result = result.replace(/(\.d)?\.[jt]sx?$/, '');
            if (!this.bazelOpts.es5Mode)
                result += '.closure';
            return result + '.js';
        }
        /**
         * Workaround https://github.com/Microsoft/TypeScript/issues/8245
         * We use the `rootDirs` property both for module resolution,
         * and *also* to flatten the structure of the output directory
         * (as `rootDir` would do for a single root).
         * To do this, look for the pattern outDir/relativeRoots[i]/path/to/file
         * or relativeRoots[i]/path/to/file
         * and replace that with path/to/file
         */
        flattenOutDir(fileName) {
            let result = fileName;
            // outDir/relativeRoots[i]/path/to/file -> relativeRoots[i]/path/to/file
            if (fileName.startsWith(this.options.rootDir)) {
                result = path.relative(this.options.outDir, fileName);
            }
            for (const dir of this.relativeRoots) {
                // relativeRoots[i]/path/to/file -> path/to/file
                const rel = path.relative(dir, result);
                if (!rel.startsWith('..')) {
                    result = rel;
                    // relativeRoots is sorted longest first so we can short-circuit
                    // after the first match
                    break;
                }
            }
            return result;
        }
        /** Avoid using tsickle on files that aren't in srcs[] */
        shouldSkipTsickleProcessing(fileName) {
            return this.bazelOpts.isJsTranspilation ||
                this.bazelOpts.compilationTargetSrc.indexOf(fileName) === -1;
        }
        /** Whether the file is expected to be imported using a named module */
        shouldNameModule(fileName) {
            return this.bazelOpts.compilationTargetSrc.indexOf(fileName) !== -1;
        }
        /** Allows suppressing warnings for specific known libraries */
        shouldIgnoreWarningsForPath(filePath) {
            return this.bazelOpts.ignoreWarningPaths.some(p => !!filePath.match(new RegExp(p)));
        }
        /**
         * fileNameToModuleId gives the module ID for an input source file name.
         * @param fileName an input source file name, e.g.
         *     /root/dir/bazel-out/host/bin/my/file.ts.
         * @return the canonical path of a file within blaze, without /genfiles/ or
         *     /bin/ path parts, excluding a file extension. For example, "my/file".
         */
        fileNameToModuleId(fileName) {
            return this.relativeOutputPath(fileName.substring(0, fileName.lastIndexOf('.')));
        }
        /**
         * TypeScript SourceFile's have a path with the rootDirs[i] still present, eg.
         * /build/work/bazel-out/local-fastbuild/bin/path/to/file
         * @return the path without any rootDirs, eg. path/to/file
         */
        rootDirsRelative(fileName) {
            for (const root of this.options.rootDirs) {
                if (fileName.startsWith(root)) {
                    // rootDirs are sorted longest-first, so short-circuit the iteration
                    // see tsconfig.ts.
                    return path.posix.relative(root, fileName);
                }
            }
            return fileName;
        }
        /**
         * Massages file names into valid goog.module names:
         * - resolves relative paths to the given context
         * - resolves non-relative paths which takes module_root into account
         * - replaces '/' with '.' in the '<workspace>' namespace
         * - replace first char if non-alpha
         * - replace subsequent non-alpha numeric chars
         */
        pathToModuleName(context, importPath) {
            // tsickle hands us an output path, we need to map it back to a source
            // path in order to do module resolution with it.
            // outDir/relativeRoots[i]/path/to/file ->
            // rootDir/relativeRoots[i]/path/to/file
            if (context.startsWith(this.options.outDir)) {
                context = path.join(this.options.rootDir, path.relative(this.options.outDir, context));
            }
            // Try to get the resolved path name from TS compiler host which can
            // handle resolution for libraries with module_root like rxjs and @angular.
            let resolvedPath = null;
            const resolved = this.moduleResolver(importPath, context, this.options, this);
            if (resolved && resolved.resolvedModule &&
                resolved.resolvedModule.resolvedFileName) {
                resolvedPath = resolved.resolvedModule.resolvedFileName;
                // /build/work/bazel-out/local-fastbuild/bin/path/to/file ->
                // path/to/file
                resolvedPath = this.rootDirsRelative(resolvedPath);
            }
            else {
                // importPath can be an absolute file path in google3.
                // Try to trim it as a path relative to bin and genfiles, and if so,
                // handle its file extension in the block below and prepend the workspace
                // name.
                const trimmed = this.rootDirsRelative(importPath);
                if (trimmed !== importPath) {
                    resolvedPath = trimmed;
                }
            }
            if (resolvedPath) {
                // Strip file extensions.
                importPath = resolvedPath.replace(SOURCE_EXT, '');
                // Make sure all module names include the workspace name.
                if (importPath.indexOf(this.bazelOpts.workspaceName) !== 0) {
                    importPath = path.posix.join(this.bazelOpts.workspaceName, importPath);
                }
            }
            // Remove the __{LOCALE} from the module name.
            if (this.bazelOpts.locale) {
                const suffix = '__' + this.bazelOpts.locale.toLowerCase();
                if (importPath.toLowerCase().endsWith(suffix)) {
                    importPath = importPath.substring(0, importPath.length - suffix.length);
                }
            }
            // Replace characters not supported by goog.module and '.' with
            // '$<Hex char code>' so that the original module name can be re-obtained
            // without any loss.
            // See goog.VALID_MODULE_RE_ in Closure's base.js for characters supported
            // by google.module.
            const escape = (c) => {
                return '$' + c.charCodeAt(0).toString(16);
            };
            const moduleName = importPath.replace(/^[^a-zA-Z_/]/, escape)
                .replace(/[^a-zA-Z_0-9_/]/g, escape)
                .replace(/\//g, '.');
            return moduleName;
        }
        /**
         * Converts file path into a valid AMD module name.
         *
         * An AMD module can have an arbitrary name, so that it is require'd by name
         * rather than by path. See http://requirejs.org/docs/whyamd.html#namedmodules
         *
         * "However, tools that combine multiple modules together for performance need
         *  a way to give names to each module in the optimized file. For that, AMD
         *  allows a string as the first argument to define()"
         */
        amdModuleName(sf) {
            if (!this.shouldNameModule(sf.fileName))
                return undefined;
            // /build/work/bazel-out/local-fastbuild/bin/path/to/file.ts
            // -> path/to/file
            let fileName = this.rootDirsRelative(sf.fileName).replace(SOURCE_EXT, '');
            let workspace = this.bazelOpts.workspaceName;
            // Workaround https://github.com/bazelbuild/bazel/issues/1262
            //
            // When the file comes from an external bazel repository,
            // and TypeScript resolves runfiles symlinks, then the path will look like
            // output_base/execroot/local_repo/external/another_repo/foo/bar
            // We want to name such a module "another_repo/foo/bar" just as it would be
            // named by code in that repository.
            // As a workaround, check for the /external/ path segment, and fix up the
            // workspace name to be the name of the external repository.
            if (fileName.startsWith('external/')) {
                const parts = fileName.split('/');
                workspace = parts[1];
                fileName = parts.slice(2).join('/');
            }
            if (this.bazelOpts.moduleName) {
                const relativeFileName = path.posix.relative(this.bazelOpts.package, fileName);
                if (!relativeFileName.startsWith('..')) {
                    if (this.bazelOpts.moduleRoot &&
                        this.bazelOpts.moduleRoot.replace(SOURCE_EXT, '') ===
                            relativeFileName) {
                        return this.bazelOpts.moduleName;
                    }
                    // Support the common case of commonjs convention that index is the
                    // default module in a directory.
                    // This makes our module naming scheme more conventional and lets users
                    // refer to modules with the natural name they're used to.
                    if (relativeFileName === 'index') {
                        return this.bazelOpts.moduleName;
                    }
                    return path.posix.join(this.bazelOpts.moduleName, relativeFileName);
                }
            }
            if (fileName.startsWith('node_modules/')) {
                return fileName.substring('node_modules/'.length);
            }
            // path/to/file ->
            // myWorkspace/path/to/file
            return path.posix.join(workspace, fileName);
        }
        /**
         * Resolves the typings file from a package at the specified path. Helper
         * function to `resolveTypeReferenceDirectives`.
         */
        resolveTypingFromDirectory(typePath, primary) {
            // Looks for the `typings` attribute in a package.json file
            // if it exists
            const pkgFile = path.posix.join(typePath, 'package.json');
            if (this.fileExists(pkgFile)) {
                const pkg = JSON.parse(fs.readFileSync(pkgFile, 'UTF-8'));
                let typings = pkg['typings'];
                if (typings) {
                    if (typings === '.' || typings === './') {
                        typings = 'index.d.ts';
                    }
                    const maybe = path.posix.join(typePath, typings);
                    if (this.fileExists(maybe)) {
                        return { primary, resolvedFileName: maybe };
                    }
                }
            }
            // Look for an index.d.ts file in the path
            const maybe = path.posix.join(typePath, 'index.d.ts');
            if (this.fileExists(maybe)) {
                return { primary, resolvedFileName: maybe };
            }
            return undefined;
        }
        /**
         * Override the default typescript resolveTypeReferenceDirectives function.
         * Resolves /// <reference types="x" /> directives under bazel. The default
         * typescript secondary search behavior needs to be overridden to support
         * looking under `bazelOpts.nodeModulesPrefix`
         */
        resolveTypeReferenceDirectives(names, containingFile) {
            if (!this.allowActionInputReads)
                return [];
            const result = [];
            names.forEach(name => {
                let resolved;
                // primary search
                this.options.typeRoots.forEach(typeRoot => {
                    if (!resolved) {
                        resolved = this.resolveTypingFromDirectory(path.posix.join(typeRoot, name), true);
                    }
                });
                // secondary search
                if (!resolved) {
                    resolved = this.resolveTypingFromDirectory(path.posix.join(this.bazelOpts.nodeModulesPrefix, name), false);
                }
                // Types not resolved should be silently ignored. Leave it to Typescript
                // to either error out with "TS2688: Cannot find type definition file for
                // 'foo'" or for the build to fail due to a missing type that is used.
                if (!resolved) {
                    if (worker_1.DEBUG) {
                        worker_1.debug(`Failed to resolve type reference directive '${name}'`);
                    }
                    return;
                }
                // In typescript 2.x the return type for this function
                // is `(ts.ResolvedTypeReferenceDirective | undefined)[]` thus we actually
                // do allow returning `undefined` in the array but the function is typed
                // `(ts.ResolvedTypeReferenceDirective)[]` to compile with both typescript
                // 2.x and 3.0/3.1 without error. Typescript 3.0/3.1 do handle the `undefined`
                // values in the array correctly despite the return signature.
                // It looks like the return type change was a mistake because
                // it was changed back to include `| undefined` recently:
                // https://github.com/Microsoft/TypeScript/pull/28059.
                result.push(resolved);
            });
            return result;
        }
        /** Loads a source file from disk (or the cache). */
        getSourceFile(fileName, languageVersion, onError) {
            return perfTrace.wrap(`getSourceFile ${fileName}`, () => {
                const sf = this.fileLoader.loadFile(fileName, fileName, languageVersion);
                if (!/\.d\.tsx?$/.test(fileName) &&
                    (this.options.module === ts.ModuleKind.AMD ||
                        this.options.module === ts.ModuleKind.UMD)) {
                    const moduleName = this.amdModuleName(sf);
                    if (sf.moduleName === moduleName || !moduleName)
                        return sf;
                    if (sf.moduleName) {
                        throw new Error(`ERROR: ${sf.fileName} ` +
                            `contains a module name declaration ${sf.moduleName} ` +
                            `which would be overwritten with ${moduleName} ` +
                            `by Bazel's TypeScript compiler.`);
                    }
                    // Setting the moduleName is equivalent to the original source having a
                    // ///<amd-module name="some/name"/> directive
                    sf.moduleName = moduleName;
                }
                return sf;
            });
        }
        writeFile(fileName, content, writeByteOrderMark, onError, sourceFiles) {
            perfTrace.wrap(`writeFile ${fileName}`, () => this.writeFileImpl(fileName, content, writeByteOrderMark, onError, sourceFiles));
        }
        writeFileImpl(fileName, content, writeByteOrderMark, onError, sourceFiles) {
            // Workaround https://github.com/Microsoft/TypeScript/issues/18648
            // This bug is fixed in TS 2.9
            const version = ts.versionMajorMinor;
            const [major, minor] = version.split('.').map(s => Number(s));
            const workaroundNeeded = major <= 2 && minor <= 8;
            if (workaroundNeeded &&
                (this.options.module === ts.ModuleKind.AMD ||
                    this.options.module === ts.ModuleKind.UMD) &&
                fileName.endsWith('.d.ts') && sourceFiles && sourceFiles.length > 0 &&
                sourceFiles[0].moduleName) {
                content =
                    `/// <amd-module name="${sourceFiles[0].moduleName}" />\n${content}`;
            }
            fileName = this.flattenOutDir(fileName);
            if (this.bazelOpts.isJsTranspilation) {
                if (this.bazelOpts.transpiledJsOutputFileName) {
                    fileName = this.bazelOpts.transpiledJsOutputFileName;
                }
                else {
                    // Strip the input directory path off of fileName to get the logical
                    // path within the input directory.
                    fileName =
                        path.relative(this.bazelOpts.transpiledJsInputDirectory, fileName);
                    // Then prepend the output directory name.
                    fileName =
                        path.join(this.bazelOpts.transpiledJsOutputDirectory, fileName);
                }
            }
            else if (!this.bazelOpts.es5Mode) {
                // Write ES6 transpiled files to *.closure.js.
                if (this.bazelOpts.locale) {
                    // i18n paths are required to end with __locale.js so we put
                    // the .closure segment before the __locale
                    fileName = fileName.replace(/(__[^\.]+)?\.js$/, '.closure$1.js');
                }
                else {
                    fileName = fileName.replace(/\.js$/, '.closure.js');
                }
            }
            // Prepend the output directory.
            fileName = path.join(this.options.outDir, fileName);
            // Our file cache is based on mtime - so avoid writing files if they
            // did not change.
            if (!fs.existsSync(fileName) ||
                fs.readFileSync(fileName, 'utf-8') !== content) {
                this.delegate.writeFile(fileName, content, writeByteOrderMark, onError, sourceFiles);
            }
        }
        /**
         * Performance optimization: don't try to stat files we weren't explicitly
         * given as inputs.
         * This also allows us to disable Bazel sandboxing, without accidentally
         * reading .ts inputs when .d.ts inputs are intended.
         * Note that in worker mode, the file cache will also guard against arbitrary
         * file reads.
         */
        fileExists(filePath) {
            // Under Bazel, users do not declare deps[] on their node_modules.
            // This means that we do not list all the needed .d.ts files in the files[]
            // section of tsconfig.json, and that is what populates the knownFiles set.
            // In addition, the node module resolver may need to read package.json files
            // and these are not permitted in the files[] section.
            // So we permit reading node_modules/* from action inputs, even though this
            // can include data[] dependencies and is broader than we would like.
            // This should only be enabled under Bazel, not Blaze.
            if (this.allowActionInputReads && filePath.indexOf('/node_modules/') >= 0) {
                const result = this.fileLoader.fileExists(filePath);
                if (worker_1.DEBUG && !result && this.delegate.fileExists(filePath)) {
                    worker_1.debug("Path exists, but is not registered in the cache", filePath);
                    Object.keys(this.fileLoader.cache.lastDigests).forEach(k => {
                        if (k.endsWith(path.basename(filePath))) {
                            worker_1.debug("  Maybe you meant to load from", k);
                        }
                    });
                }
                return result;
            }
            return this.knownFiles.has(filePath);
        }
        getDefaultLibLocation() {
            // Since we override getDefaultLibFileName below, we must also provide the
            // directory containing the file.
            // Otherwise TypeScript looks in C:\lib.xxx.d.ts for the default lib.
            return path.dirname(this.getDefaultLibFileName({ target: ts.ScriptTarget.ES5 }));
        }
        getDefaultLibFileName(options) {
            if (this.bazelOpts.nodeModulesPrefix) {
                return path.join(this.bazelOpts.nodeModulesPrefix, 'typescript/lib', ts.getDefaultLibFileName({ target: ts.ScriptTarget.ES5 }));
            }
            return this.delegate.getDefaultLibFileName(options);
        }
        realpath(s) {
            // tsc-wrapped relies on string matching of file paths for things like the
            // file cache and for strict deps checking.
            // TypeScript will try to resolve symlinks during module resolution which
            // makes our checks fail: the path we resolved as an input isn't the same
            // one the module resolver will look for.
            // See https://github.com/Microsoft/TypeScript/pull/12020
            // So we simply turn off symlink resolution.
            return s;
        }
        // Delegate everything else to the original compiler host.
        getCanonicalFileName(path) {
            return this.delegate.getCanonicalFileName(path);
        }
        getCurrentDirectory() {
            return this.delegate.getCurrentDirectory();
        }
        useCaseSensitiveFileNames() {
            return this.delegate.useCaseSensitiveFileNames();
        }
        getNewLine() {
            return this.delegate.getNewLine();
        }
        getDirectories(path) {
            return this.delegate.getDirectories ? this.delegate.getDirectories(path) :
                [];
        }
        readFile(fileName) {
            return this.delegate.readFile(fileName);
        }
        trace(s) {
            console.error(s);
        }
    }
    exports.CompilerHost = CompilerHost;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29tcGlsZXJfaG9zdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uLy4uL2V4dGVybmFsL2J1aWxkX2JhemVsX3J1bGVzX3R5cGVzY3JpcHQvaW50ZXJuYWwvdHNjX3dyYXBwZWQvY29tcGlsZXJfaG9zdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztJQUFBLHlCQUF5QjtJQUN6Qiw2QkFBNkI7SUFFN0IsaUNBQWlDO0lBR2pDLDBDQUEwQztJQUUxQyxxQ0FBc0M7SUFrQnRDLFNBQWdCLGVBQWUsQ0FBQyxPQUEyQjtRQUN6RCxJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRTtZQUNyQixNQUFNLElBQUksS0FBSyxDQUFDLHdEQUF3RCxDQUFDLENBQUM7U0FDM0U7UUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRTtZQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7U0FDMUU7UUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRTtZQUNuQixNQUFNLElBQUksS0FBSyxDQUFDLHNEQUFzRCxDQUFDLENBQUM7U0FDekU7UUFDRCxPQUFPLE9BQXlCLENBQUM7SUFDbkMsQ0FBQztJQVhELDBDQVdDO0lBRUQsU0FBUyxvQkFBb0IsQ0FBQyxTQUF1QjtRQUNuRCxJQUFJLENBQUMsU0FBUyxDQUFDLGlCQUFpQjtZQUFFLE9BQU87UUFFekMsSUFBSSxTQUFTLENBQUMsb0JBQW9CO1lBQzlCLFNBQVMsQ0FBQyxvQkFBb0IsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO1lBQzdDLE1BQU0sSUFBSSxLQUFLLENBQ1gsd0RBQXdEO2dCQUN4RCxvQ0FBb0MsQ0FBQyxDQUFDO1NBQzNDO1FBRUQsSUFBSSxDQUFDLFNBQVMsQ0FBQywwQkFBMEI7WUFDckMsQ0FBQyxTQUFTLENBQUMsMkJBQTJCLEVBQUU7WUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FDWCxpRUFBaUU7Z0JB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aW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIHRzaWNrbGUgZnJvbSAndHNpY2tsZSc7XG5pbXBvcnQgKiBhcyB0cyBmcm9tICd0eXBlc2NyaXB0JztcblxuaW1wb3J0IHtGaWxlTG9hZGVyfSBmcm9tICcuL2NhY2hlJztcbmltcG9ydCAqIGFzIHBlcmZUcmFjZSBmcm9tICcuL3BlcmZfdHJhY2UnO1xuaW1wb3J0IHtCYXplbE9wdGlvbnN9IGZyb20gJy4vdHNjb25maWcnO1xuaW1wb3J0IHtERUJVRywgZGVidWd9IGZyb20gJy4vd29ya2VyJztcblxuZXhwb3J0IHR5cGUgTW9kdWxlUmVzb2x2ZXIgPVxuICAgIChtb2R1bGVOYW1lOiBzdHJpbmcsIGNvbnRhaW5pbmdGaWxlOiBzdHJpbmcsXG4gICAgIGNvbXBpbGVyT3B0aW9uczogdHMuQ29tcGlsZXJPcHRpb25zLCBob3N0OiB0cy5Nb2R1bGVSZXNvbHV0aW9uSG9zdCkgPT5cbiAgICAgICAgdHMuUmVzb2x2ZWRNb2R1bGVXaXRoRmFpbGVkTG9va3VwTG9jYXRpb25zO1xuXG4vKipcbiAqIE5hcnJvd3MgZG93biB0aGUgdHlwZSBvZiBzb21lIHByb3BlcnRpZXMgZnJvbSBub24tb3B0aW9uYWwgdG8gcmVxdWlyZWQsIHNvXG4gKiB0aGF0IHdlIGRvIG5vdCBuZWVkIHRvIGNoZWNrIHByZXNlbmNlIGJlZm9yZSBlYWNoIGFjY2Vzcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBCYXplbFRzT3B0aW9ucyBleHRlbmRzIHRzLkNvbXBpbGVyT3B0aW9ucyB7XG4gIHJvb3REaXJzOiBzdHJpbmdbXTtcbiAgcm9vdERpcjogc3RyaW5nO1xuICBvdXREaXI6IHN0cmluZztcbiAgdHlwZVJvb3RzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5hcnJvd1RzT3B0aW9ucyhvcHRpb25zOiB0cy5Db21waWxlck9wdGlvbnMpOiBCYXplbFRzT3B0aW9ucyB7XG4gIGlmICghb3B0aW9ucy5yb290RGlycykge1xuICAgIHRocm93IG5ldyBFcnJvcihgY29tcGlsZXJPcHRpb25zLnJvb3REaXJzIHNob3VsZCBiZSBzZXQgYnkgdHNjb25maWcuYnpsYCk7XG4gIH1cbiAgaWYgKCFvcHRpb25zLnJvb3REaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGNvbXBpbGVyT3B0aW9ucy5yb290RGlyIHNob3VsZCBiZSBzZXQgYnkgdHNjb25maWcuYnpsYCk7XG4gIH1cbiAgaWYgKCFvcHRpb25zLm91dERpcikge1xuICAgIHRocm93IG5ldyBFcnJvcihgY29tcGlsZXJPcHRpb25zLm91dERpciBzaG91bGQgYmUgc2V0IGJ5IHRzY29uZmlnLmJ6bGApO1xuICB9XG4gIHJldHVybiBvcHRpb25zIGFzIEJhemVsVHNPcHRpb25zO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUJhemVsT3B0aW9ucyhiYXplbE9wdHM6IEJhemVsT3B0aW9ucykge1xuICBpZiAoIWJhemVsT3B0cy5pc0pzVHJhbnNwaWxhdGlvbikgcmV0dXJuO1xuXG4gIGlmIChiYXplbE9wdHMuY29tcGlsYXRpb25UYXJnZXRTcmMgJiZcbiAgICAgIGJhemVsT3B0cy5jb21waWxhdGlvblRhcmdldFNyYy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAnSW4gSlMgdHJhbnNwaWxhdGlvbiBtb2RlLCBvbmx5IG9uZSBmaWxlIGNhbiBhcHBlYXIgaW4gJyArXG4gICAgICAgICdiYXplbE9wdGlvbnMuY29tcGlsYXRpb25UYXJnZXRTcmMuJyk7XG4gIH1cblxuICBpZiAoIWJhemVsT3B0cy50cmFuc3BpbGVkSnNPdXRwdXRGaWxlTmFtZSAmJlxuICAgICAgIWJhemVsT3B0cy50cmFuc3BpbGVkSnNPdXRwdXREaXJlY3RvcnkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdJbiBKUyB0cmFuc3BpbGF0aW9uIG1vZGUsIGVpdGhlciB0cmFuc3BpbGVkSnNPdXRwdXRGaWxlTmFtZSBvciAnICtcbiAgICAgICAgJ3RyYW5zcGlsZWRKc091dHB1dERpcmVjdG9yeSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0c2NvbmZpZy4nKTtcbiAgfVxuXG4gIGlmIChiYXplbE9wdHMudHJhbnNwaWxlZEpzT3V0cHV0RmlsZU5hbWUgJiZcbiAgICAgIGJhemVsT3B0cy50cmFuc3BpbGVkSnNPdXRwdXREaXJlY3RvcnkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdJbiBKUyB0cmFuc3BpbGF0aW9uIG1vZGUsIGNhbm5vdCBzZXQgYm90aCAnICtcbiAgICAgICAgJ3RyYW5zcGlsZWRKc091dHB1dEZpbGVOYW1lIGFuZCB0cmFuc3BpbGVkSnNPdXRwdXREaXJlY3RvcnkuJyk7XG4gIH1cbn1cblxuY29uc3QgU09VUkNFX0VYVCA9IC8oKFxcLmQpP1xcLnRzeD98XFwuanMpJC87XG5cbi8qKlxuICogQ29tcGlsZXJIb3N0IHRoYXQga25vd3MgaG93IHRvIGNhY2hlIHBhcnNlZCBmaWxlcyB0byBpbXByb3ZlIGNvbXBpbGUgdGltZXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb21waWxlckhvc3QgaW1wbGVtZW50cyB0cy5Db21waWxlckhvc3QsIHRzaWNrbGUuVHNpY2tsZUhvc3Qge1xuICAvKipcbiAgICogTG9va3VwIHRhYmxlIHRvIGFuc3dlciBmaWxlIHN0YXQncyB3aXRob3V0IGxvb2tpbmcgb24gZGlzay5cbiAgICovXG4gIHByaXZhdGUga25vd25GaWxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiByb290RGlycyByZWxhdGl2ZSB0byB0aGUgcm9vdERpciwgZWcgXCJiYXplbC1vdXQvbG9jYWwtZmFzdGJ1aWxkL2JpblwiXG4gICAqL1xuICBwcml2YXRlIHJlbGF0aXZlUm9vdHM6IHN0cmluZ1tdO1xuXG4gIGdldENhbmNlbGF0aW9uVG9rZW4/OiAoKSA9PiB0cy5DYW5jZWxsYXRpb25Ub2tlbjtcbiAgZGlyZWN0b3J5RXhpc3RzPzogKGRpcjogc3RyaW5nKSA9PiBib29sZWFuO1xuXG4gIGdvb2dtb2R1bGU6IGJvb2xlYW47XG4gIGVzNU1vZGU6IGJvb2xlYW47XG4gIHByZWx1ZGU6IHN0cmluZztcbiAgdW50eXBlZDogYm9vbGVhbjtcbiAgdHlwZUJsYWNrTGlzdFBhdGhzOiBTZXQ8c3RyaW5nPjtcbiAgdHJhbnNmb3JtRGVjb3JhdG9yczogYm9vbGVhbjtcbiAgdHJhbnNmb3JtVHlwZXNUb0Nsb3N1cmU6IGJvb2xlYW47XG4gIGFkZER0c0NsdXR6QWxpYXNlczogYm9vbGVhbjtcbiAgaXNKc1RyYW5zcGlsYXRpb246IGJvb2xlYW47XG4gIHByb3ZpZGVFeHRlcm5hbE1vZHVsZUR0c05hbWVzcGFjZTogYm9vbGVhbjtcbiAgb3B0aW9uczogQmF6ZWxUc09wdGlvbnM7XG4gIG1vZHVsZVJlc29sdXRpb25Ib3N0OiB0cy5Nb2R1bGVSZXNvbHV0aW9uSG9zdCA9IHRoaXM7XG4gIC8vIFRPRE8oZXZhbm0pOiBkZWxldGUgdGhpcyBvbmNlIHRzaWNrbGUgaXMgdXBkYXRlZC5cbiAgaG9zdDogdHMuTW9kdWxlUmVzb2x1dGlvbkhvc3QgPSB0aGlzO1xuICBwcml2YXRlIGFsbG93QWN0aW9uSW5wdXRSZWFkcyA9IHRydWU7XG5cblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHB1YmxpYyBpbnB1dEZpbGVzOiBzdHJpbmdbXSwgb3B0aW9uczogdHMuQ29tcGlsZXJPcHRpb25zLFxuICAgICAgcmVhZG9ubHkgYmF6ZWxPcHRzOiBCYXplbE9wdGlvbnMsIHByaXZhdGUgZGVsZWdhdGU6IHRzLkNvbXBpbGVySG9zdCxcbiAgICAgIHByaXZhdGUgZmlsZUxvYWRlcjogRmlsZUxvYWRlcixcbiAgICAgIHByaXZhdGUgbW9kdWxlUmVzb2x2ZXI6IE1vZHVsZVJlc29sdmVyID0gdHMucmVzb2x2ZU1vZHVsZU5hbWUpIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBuYXJyb3dUc09wdGlvbnMob3B0aW9ucyk7XG4gICAgdGhpcy5yZWxhdGl2ZVJvb3RzID1cbiAgICAgICAgdGhpcy5vcHRpb25zLnJvb3REaXJzLm1hcChyID0+IHBhdGgucmVsYXRpdmUodGhpcy5vcHRpb25zLnJvb3REaXIsIHIpKTtcbiAgICBpbnB1dEZpbGVzLmZvckVhY2goKGYpID0+IHtcbiAgICAgIHRoaXMua25vd25GaWxlcy5hZGQoZik7XG4gICAgfSk7XG5cbiAgICAvLyBnZXRDYW5jZWxhdGlvblRva2VuIGlzIGFuIG9wdGlvbmFsIG1ldGhvZCBvbiB0aGUgZGVsZWdhdGUuIElmIHdlXG4gICAgLy8gdW5jb25kaXRpb25hbGx5IGltcGxlbWVudCB0aGUgbWV0aG9kLCB3ZSB3aWxsIGJlIGZvcmNlZCB0byByZXR1cm4gbnVsbCxcbiAgICAvLyBpbiB0aGUgYWJzZW5zZSBvZiB0aGUgZGVsZWdhdGUgbWV0aG9kLiBUaGF0IHdvbid0IG1hdGNoIHRoZSByZXR1cm4gdHlwZS5cbiAgICAvLyBJbnN0ZWFkLCB3ZSBvcHRpb25hbGx5IHNldCBhIGZ1bmN0aW9uIHRvIGEgZmllbGQgd2l0aCB0aGUgc2FtZSBuYW1lLlxuICAgIGlmIChkZWxlZ2F0ZSAmJiBkZWxlZ2F0ZS5nZXRDYW5jZWxsYXRpb25Ub2tlbikge1xuICAgICAgdGhpcy5nZXRDYW5jZWxhdGlvblRva2VuID0gZGVsZWdhdGUuZ2V0Q2FuY2VsbGF0aW9uVG9rZW4uYmluZChkZWxlZ2F0ZSk7XG4gICAgfVxuXG4gICAgLy8gT3ZlcnJpZGUgZGlyZWN0b3J5RXhpc3RzIHNvIHRoYXQgVHlwZVNjcmlwdCBjYW4gYXV0b21hdGljYWxseVxuICAgIC8vIGluY2x1ZGUgZ2xvYmFsIHR5cGluZ3MgZnJvbSBub2RlX21vZHVsZXMvQHR5cGVzXG4gICAgLy8gc2VlIGdldEF1dG9tYXRpY1R5cGVEaXJlY3RpdmVOYW1lcyBpblxuICAgIC8vIFR5cGVTY3JpcHQ6c3JjL2NvbXBpbGVyL21vZHVsZU5hbWVSZXNvbHZlclxuICAgIGlmICh0aGlzLmFsbG93QWN0aW9uSW5wdXRSZWFkcyAmJiBkZWxlZ2F0ZSAmJiBkZWxlZ2F0ZS5kaXJlY3RvcnlFeGlzdHMpIHtcbiAgICAgIHRoaXMuZGlyZWN0b3J5RXhpc3RzID0gZGVsZWdhdGUuZGlyZWN0b3J5RXhpc3RzLmJpbmQoZGVsZWdhdGUpO1xuICAgIH1cblxuICAgIHZhbGlkYXRlQmF6ZWxPcHRpb25zKGJhemVsT3B0cyk7XG4gICAgdGhpcy5nb29nbW9kdWxlID0gYmF6ZWxPcHRzLmdvb2dtb2R1bGU7XG4gICAgdGhpcy5lczVNb2RlID0gYmF6ZWxPcHRzLmVzNU1vZGU7XG4gICAgdGhpcy5wcmVsdWRlID0gYmF6ZWxPcHRzLnByZWx1ZGU7XG4gICAgdGhpcy51bnR5cGVkID0gYmF6ZWxPcHRzLnVudHlwZWQ7XG4gICAgdGhpcy50eXBlQmxhY2tMaXN0UGF0aHMgPSBuZXcgU2V0KGJhemVsT3B0cy50eXBlQmxhY2tMaXN0UGF0aHMpO1xuICAgIHRoaXMudHJhbnNmb3JtRGVjb3JhdG9ycyA9IGJhemVsT3B0cy50c2lja2xlO1xuICAgIHRoaXMudHJhbnNmb3JtVHlwZXNUb0Nsb3N1cmUgPSBiYXplbE9wdHMudHNpY2tsZTtcbiAgICB0aGlzLmFkZER0c0NsdXR6QWxpYXNlcyA9IGJhemVsT3B0cy5hZGREdHNDbHV0ekFsaWFzZXM7XG4gICAgdGhpcy5pc0pzVHJhbnNwaWxhdGlvbiA9IEJvb2xlYW4oYmF6ZWxPcHRzLmlzSnNUcmFuc3BpbGF0aW9uKTtcbiAgICB0aGlzLnByb3ZpZGVFeHRlcm5hbE1vZHVsZUR0c05hbWVzcGFjZSA9ICFiYXplbE9wdHMuaGFzSW1wbGVtZW50YXRpb247XG4gIH1cblxuICAvKipcbiAgICogRm9yIHRoZSBnaXZlbiBwb3RlbnRpYWxseSBhYnNvbHV0ZSBpbnB1dCBmaWxlIHBhdGggKHR5cGljYWxseSAudHMpLCByZXR1cm5zXG4gICAqIHRoZSByZWxhdGl2ZSBvdXRwdXQgcGF0aC4gRm9yIGV4YW1wbGUsIGZvclxuICAgKiAvcGF0aC90by9yb290L2JsYXplLW91dC9rOC1mYXN0YnVpbGQvZ2VuZmlsZXMvbXkvZmlsZS50cywgd2lsbCByZXR1cm5cbiAgICogbXkvZmlsZS5qcyBvciBteS9maWxlLmNsb3N1cmUuanMgKGRlcGVuZGluZyBvbiBFUzUgbW9kZSkuXG4gICAqL1xuICByZWxhdGl2ZU91dHB1dFBhdGgoZmlsZU5hbWU6IHN0cmluZykge1xuICAgIGxldCByZXN1bHQgPSB0aGlzLnJvb3REaXJzUmVsYXRpdmUoZmlsZU5hbWUpO1xuICAgIHJlc3VsdCA9IHJlc3VsdC5yZXBsYWNlKC8oXFwuZCk/XFwuW2p0XXN4PyQvLCAnJyk7XG4gICAgaWYgKCF0aGlzLmJhemVsT3B0cy5lczVNb2RlKSByZXN1bHQgKz0gJy5jbG9zdXJlJztcbiAgICByZXR1cm4gcmVzdWx0ICsgJy5qcyc7XG4gIH1cblxuICAvKipcbiAgICogV29ya2Fyb3VuZCBodHRwczovL2dpdGh1Yi5jb20vTWljcm9zb2Z0L1R5cGVTY3JpcHQvaXNzdWVzLzgyNDVcbiAgICogV2UgdXNlIHRoZSBgcm9vdERpcnNgIHByb3BlcnR5IGJvdGggZm9yIG1vZHVsZSByZXNvbHV0aW9uLFxuICAgKiBhbmQgKmFsc28qIHRvIGZsYXR0ZW4gdGhlIHN0cnVjdHVyZSBvZiB0aGUgb3V0cHV0IGRpcmVjdG9yeVxuICAgKiAoYXMgYHJvb3REaXJgIHdvdWxkIGRvIGZvciBhIHNpbmdsZSByb290KS5cbiAgICogVG8gZG8gdGhpcywgbG9vayBmb3IgdGhlIHBhdHRlcm4gb3V0RGlyL3JlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlXG4gICAqIG9yIHJlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlXG4gICAqIGFuZCByZXBsYWNlIHRoYXQgd2l0aCBwYXRoL3RvL2ZpbGVcbiAgICovXG4gIGZsYXR0ZW5PdXREaXIoZmlsZU5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgbGV0IHJlc3VsdCA9IGZpbGVOYW1lO1xuXG4gICAgLy8gb3V0RGlyL3JlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlIC0+IHJlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlXG4gICAgaWYgKGZpbGVOYW1lLnN0YXJ0c1dpdGgodGhpcy5vcHRpb25zLnJvb3REaXIpKSB7XG4gICAgICByZXN1bHQgPSBwYXRoLnJlbGF0aXZlKHRoaXMub3B0aW9ucy5vdXREaXIsIGZpbGVOYW1lKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGRpciBvZiB0aGlzLnJlbGF0aXZlUm9vdHMpIHtcbiAgICAgIC8vIHJlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlIC0+IHBhdGgvdG8vZmlsZVxuICAgICAgY29uc3QgcmVsID0gcGF0aC5yZWxhdGl2ZShkaXIsIHJlc3VsdCk7XG4gICAgICBpZiAoIXJlbC5zdGFydHNXaXRoKCcuLicpKSB7XG4gICAgICAgIHJlc3VsdCA9IHJlbDtcbiAgICAgICAgLy8gcmVsYXRpdmVSb290cyBpcyBzb3J0ZWQgbG9uZ2VzdCBmaXJzdCBzbyB3ZSBjYW4gc2hvcnQtY2lyY3VpdFxuICAgICAgICAvLyBhZnRlciB0aGUgZmlyc3QgbWF0Y2hcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvKiogQXZvaWQgdXNpbmcgdHNpY2tsZSBvbiBmaWxlcyB0aGF0IGFyZW4ndCBpbiBzcmNzW10gKi9cbiAgc2hvdWxkU2tpcFRzaWNrbGVQcm9jZXNzaW5nKGZpbGVOYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5iYXplbE9wdHMuaXNKc1RyYW5zcGlsYXRpb24gfHxcbiAgICAgICAgICAgdGhpcy5iYXplbE9wdHMuY29tcGlsYXRpb25UYXJnZXRTcmMuaW5kZXhPZihmaWxlTmFtZSkgPT09IC0xO1xuICB9XG5cbiAgLyoqIFdoZXRoZXIgdGhlIGZpbGUgaXMgZXhwZWN0ZWQgdG8gYmUgaW1wb3J0ZWQgdXNpbmcgYSBuYW1lZCBtb2R1bGUgKi9cbiAgc2hvdWxkTmFtZU1vZHVsZShmaWxlTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuYmF6ZWxPcHRzLmNvbXBpbGF0aW9uVGFyZ2V0U3JjLmluZGV4T2YoZmlsZU5hbWUpICE9PSAtMTtcbiAgfVxuXG4gIC8qKiBBbGxvd3Mgc3VwcHJlc3Npbmcgd2FybmluZ3MgZm9yIHNwZWNpZmljIGtub3duIGxpYnJhcmllcyAqL1xuICBzaG91bGRJZ25vcmVXYXJuaW5nc0ZvclBhdGgoZmlsZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmJhemVsT3B0cy5pZ25vcmVXYXJuaW5nUGF0aHMuc29tZShcbiAgICAgICAgcCA9PiAhIWZpbGVQYXRoLm1hdGNoKG5ldyBSZWdFeHAocCkpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBmaWxlTmFtZVRvTW9kdWxlSWQgZ2l2ZXMgdGhlIG1vZHVsZSBJRCBmb3IgYW4gaW5wdXQgc291cmNlIGZpbGUgbmFtZS5cbiAgICogQHBhcmFtIGZpbGVOYW1lIGFuIGlucHV0IHNvdXJjZSBmaWxlIG5hbWUsIGUuZy5cbiAgICogICAgIC9yb290L2Rpci9iYXplbC1vdXQvaG9zdC9iaW4vbXkvZmlsZS50cy5cbiAgICogQHJldHVybiB0aGUgY2Fub25pY2FsIHBhdGggb2YgYSBmaWxlIHdpdGhpbiBibGF6ZSwgd2l0aG91dCAvZ2VuZmlsZXMvIG9yXG4gICAqICAgICAvYmluLyBwYXRoIHBhcnRzLCBleGNsdWRpbmcgYSBmaWxlIGV4dGVuc2lvbi4gRm9yIGV4YW1wbGUsIFwibXkvZmlsZVwiLlxuICAgKi9cbiAgZmlsZU5hbWVUb01vZHVsZUlkKGZpbGVOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLnJlbGF0aXZlT3V0cHV0UGF0aChcbiAgICAgICAgZmlsZU5hbWUuc3Vic3RyaW5nKDAsIGZpbGVOYW1lLmxhc3RJbmRleE9mKCcuJykpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUeXBlU2NyaXB0IFNvdXJjZUZpbGUncyBoYXZlIGEgcGF0aCB3aXRoIHRoZSByb290RGlyc1tpXSBzdGlsbCBwcmVzZW50LCBlZy5cbiAgICogL2J1aWxkL3dvcmsvYmF6ZWwtb3V0L2xvY2FsLWZhc3RidWlsZC9iaW4vcGF0aC90by9maWxlXG4gICAqIEByZXR1cm4gdGhlIHBhdGggd2l0aG91dCBhbnkgcm9vdERpcnMsIGVnLiBwYXRoL3RvL2ZpbGVcbiAgICovXG4gIHByaXZhdGUgcm9vdERpcnNSZWxhdGl2ZShmaWxlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgdGhpcy5vcHRpb25zLnJvb3REaXJzKSB7XG4gICAgICBpZiAoZmlsZU5hbWUuc3RhcnRzV2l0aChyb290KSkge1xuICAgICAgICAvLyByb290RGlycyBhcmUgc29ydGVkIGxvbmdlc3QtZmlyc3QsIHNvIHNob3J0LWNpcmN1aXQgdGhlIGl0ZXJhdGlvblxuICAgICAgICAvLyBzZWUgdHNjb25maWcudHMuXG4gICAgICAgIHJldHVybiBwYXRoLnBvc2l4LnJlbGF0aXZlKHJvb3QsIGZpbGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZpbGVOYW1lO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hc3NhZ2VzIGZpbGUgbmFtZXMgaW50byB2YWxpZCBnb29nLm1vZHVsZSBuYW1lczpcbiAgICogLSByZXNvbHZlcyByZWxhdGl2ZSBwYXRocyB0byB0aGUgZ2l2ZW4gY29udGV4dFxuICAgKiAtIHJlc29sdmVzIG5vbi1yZWxhdGl2ZSBwYXRocyB3aGljaCB0YWtlcyBtb2R1bGVfcm9vdCBpbnRvIGFjY291bnRcbiAgICogLSByZXBsYWNlcyAnLycgd2l0aCAnLicgaW4gdGhlICc8d29ya3NwYWNlPicgbmFtZXNwYWNlXG4gICAqIC0gcmVwbGFjZSBmaXJzdCBjaGFyIGlmIG5vbi1hbHBoYVxuICAgKiAtIHJlcGxhY2Ugc3Vic2VxdWVudCBub24tYWxwaGEgbnVtZXJpYyBjaGFyc1xuICAgKi9cbiAgcGF0aFRvTW9kdWxlTmFtZShjb250ZXh0OiBzdHJpbmcsIGltcG9ydFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgLy8gdHNpY2tsZSBoYW5kcyB1cyBhbiBvdXRwdXQgcGF0aCwgd2UgbmVlZCB0byBtYXAgaXQgYmFjayB0byBhIHNvdXJjZVxuICAgIC8vIHBhdGggaW4gb3JkZXIgdG8gZG8gbW9kdWxlIHJlc29sdXRpb24gd2l0aCBpdC5cbiAgICAvLyBvdXREaXIvcmVsYXRpdmVSb290c1tpXS9wYXRoL3RvL2ZpbGUgLT5cbiAgICAvLyByb290RGlyL3JlbGF0aXZlUm9vdHNbaV0vcGF0aC90by9maWxlXG4gICAgaWYgKGNvbnRleHQuc3RhcnRzV2l0aCh0aGlzLm9wdGlvbnMub3V0RGlyKSkge1xuICAgICAgY29udGV4dCA9IHBhdGguam9pbihcbiAgICAgICAgICB0aGlzLm9wdGlvbnMucm9vdERpciwgcGF0aC5yZWxhdGl2ZSh0aGlzLm9wdGlvbnMub3V0RGlyLCBjb250ZXh0KSk7XG4gICAgfVxuXG4gICAgLy8gVHJ5IHRvIGdldCB0aGUgcmVzb2x2ZWQgcGF0aCBuYW1lIGZyb20gVFMgY29tcGlsZXIgaG9zdCB3aGljaCBjYW5cbiAgICAvLyBoYW5kbGUgcmVzb2x1dGlvbiBmb3IgbGlicmFyaWVzIHdpdGggbW9kdWxlX3Jvb3QgbGlrZSByeGpzIGFuZCBAYW5ndWxhci5cbiAgICBsZXQgcmVzb2x2ZWRQYXRoOiBzdHJpbmd8bnVsbCA9IG51bGw7XG4gICAgY29uc3QgcmVzb2x2ZWQgPVxuICAgICAgICB0aGlzLm1vZHVsZVJlc29sdmVyKGltcG9ydFBhdGgsIGNvbnRleHQsIHRoaXMub3B0aW9ucywgdGhpcyk7XG4gICAgaWYgKHJlc29sdmVkICYmIHJlc29sdmVkLnJlc29sdmVkTW9kdWxlICYmXG4gICAgICAgIHJlc29sdmVkLnJlc29sdmVkTW9kdWxlLnJlc29sdmVkRmlsZU5hbWUpIHtcbiAgICAgIHJlc29sdmVkUGF0aCA9IHJlc29sdmVkLnJlc29sdmVkTW9kdWxlLnJlc29sdmVkRmlsZU5hbWU7XG4gICAgICAvLyAvYnVpbGQvd29yay9iYXplbC1vdXQvbG9jYWwtZmFzdGJ1aWxkL2Jpbi9wYXRoL3RvL2ZpbGUgLT5cbiAgICAgIC8vIHBhdGgvdG8vZmlsZVxuICAgICAgcmVzb2x2ZWRQYXRoID0gdGhpcy5yb290RGlyc1JlbGF0aXZlKHJlc29sdmVkUGF0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIGltcG9ydFBhdGggY2FuIGJlIGFuIGFic29sdXRlIGZpbGUgcGF0aCBpbiBnb29nbGUzLlxuICAgICAgLy8gVHJ5IHRvIHRyaW0gaXQgYXMgYSBwYXRoIHJlbGF0aXZlIHRvIGJpbiBhbmQgZ2VuZmlsZXMsIGFuZCBpZiBzbyxcbiAgICAgIC8vIGhhbmRsZSBpdHMgZmlsZSBleHRlbnNpb24gaW4gdGhlIGJsb2NrIGJlbG93IGFuZCBwcmVwZW5kIHRoZSB3b3Jrc3BhY2VcbiAgICAgIC8vIG5hbWUuXG4gICAgICBjb25zdCB0cmltbWVkID0gdGhpcy5yb290RGlyc1JlbGF0aXZlKGltcG9ydFBhdGgpO1xuICAgICAgaWYgKHRyaW1tZWQgIT09IGltcG9ydFBhdGgpIHtcbiAgICAgICAgcmVzb2x2ZWRQYXRoID0gdHJpbW1lZDtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJlc29sdmVkUGF0aCkge1xuICAgICAgLy8gU3RyaXAgZmlsZSBleHRlbnNpb25zLlxuICAgICAgaW1wb3J0UGF0aCA9IHJlc29sdmVkUGF0aC5yZXBsYWNlKFNPVVJDRV9FWFQsICcnKTtcbiAgICAgIC8vIE1ha2Ugc3VyZSBhbGwgbW9kdWxlIG5hbWVzIGluY2x1ZGUgdGhlIHdvcmtzcGFjZSBuYW1lLlxuICAgICAgaWYgKGltcG9ydFBhdGguaW5kZXhPZih0aGlzLmJhemVsT3B0cy53b3Jrc3BhY2VOYW1lKSAhPT0gMCkge1xuICAgICAgICBpbXBvcnRQYXRoID0gcGF0aC5wb3NpeC5qb2luKHRoaXMuYmF6ZWxPcHRzLndvcmtzcGFjZU5hbWUsIGltcG9ydFBhdGgpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlbW92ZSB0aGUgX197TE9DQUxFfSBmcm9tIHRoZSBtb2R1bGUgbmFtZS5cbiAgICBpZiAodGhpcy5iYXplbE9wdHMubG9jYWxlKSB7XG4gICAgICBjb25zdCBzdWZmaXggPSAnX18nICsgdGhpcy5iYXplbE9wdHMubG9jYWxlLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAoaW1wb3J0UGF0aC50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgaW1wb3J0UGF0aCA9IGltcG9ydFBhdGguc3Vic3RyaW5nKDAsIGltcG9ydFBhdGgubGVuZ3RoIC0gc3VmZml4Lmxlbmd0aCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmVwbGFjZSBjaGFyYWN0ZXJzIG5vdCBzdXBwb3J0ZWQgYnkgZ29vZy5tb2R1bGUgYW5kICcuJyB3aXRoXG4gICAgLy8gJyQ8SGV4IGNoYXIgY29kZT4nIHNvIHRoYXQgdGhlIG9yaWdpbmFsIG1vZHVsZSBuYW1lIGNhbiBiZSByZS1vYnRhaW5lZFxuICAgIC8vIHdpdGhvdXQgYW55IGxvc3MuXG4gICAgLy8gU2VlIGdvb2cuVkFMSURfTU9EVUxFX1JFXyBpbiBDbG9zdXJlJ3MgYmFzZS5qcyBmb3IgY2hhcmFjdGVycyBzdXBwb3J0ZWRcbiAgICAvLyBieSBnb29nbGUubW9kdWxlLlxuXG4gICAgY29uc3QgZXNjYXBlID0gKGM6IHN0cmluZykgPT4ge1xuICAgICAgcmV0dXJuICckJyArIGMuY2hhckNvZGVBdCgwKS50b1N0cmluZygxNik7XG4gICAgfTtcbiAgICBjb25zdCBtb2R1bGVOYW1lID0gaW1wb3J0UGF0aC5yZXBsYWNlKC9eW15hLXpBLVpfL10vLCBlc2NhcGUpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvW15hLXpBLVpfMC05Xy9dL2csIGVzY2FwZSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXC8vZywgJy4nKTtcbiAgICByZXR1cm4gbW9kdWxlTmFtZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb252ZXJ0cyBmaWxlIHBhdGggaW50byBhIHZhbGlkIEFNRCBtb2R1bGUgbmFtZS5cbiAgICpcbiAgICogQW4gQU1EIG1vZHVsZSBjYW4gaGF2ZSBhbiBhcmJpdHJhcnkgbmFtZSwgc28gdGhhdCBpdCBpcyByZXF1aXJlJ2QgYnkgbmFtZVxuICAgKiByYXRoZXIgdGhhbiBieSBwYXRoLiBTZWUgaHR0cDovL3JlcXVpcmVqcy5vcmcvZG9jcy93aHlhbWQuaHRtbCNuYW1lZG1vZHVsZXNcbiAgICpcbiAgICogXCJIb3dldmVyLCB0b29scyB0aGF0IGNvbWJpbmUgbXVsdGlwbGUgbW9kdWxlcyB0b2dldGhlciBmb3IgcGVyZm9ybWFuY2UgbmVlZFxuICAgKiAgYSB3YXkgdG8gZ2l2ZSBuYW1lcyB0byBlYWNoIG1vZHVsZSBpbiB0aGUgb3B0aW1pemVkIGZpbGUuIEZvciB0aGF0LCBBTURcbiAgICogIGFsbG93cyBhIHN0cmluZyBhcyB0aGUgZmlyc3QgYXJndW1lbnQgdG8gZGVmaW5lKClcIlxuICAgKi9cbiAgYW1kTW9kdWxlTmFtZShzZjogdHMuU291cmNlRmlsZSk6IHN0cmluZ3x1bmRlZmluZWQge1xuICAgIGlmICghdGhpcy5zaG91bGROYW1lTW9kdWxlKHNmLmZpbGVOYW1lKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAvLyAvYnVpbGQvd29yay9iYXplbC1vdXQvbG9jYWwtZmFzdGJ1aWxkL2Jpbi9wYXRoL3RvL2ZpbGUudHNcbiAgICAvLyAtPiBwYXRoL3RvL2ZpbGVcbiAgICBsZXQgZmlsZU5hbWUgPSB0aGlzLnJvb3REaXJzUmVsYXRpdmUoc2YuZmlsZU5hbWUpLnJlcGxhY2UoU09VUkNFX0VYVCwgJycpO1xuXG4gICAgbGV0IHdvcmtzcGFjZSA9IHRoaXMuYmF6ZWxPcHRzLndvcmtzcGFjZU5hbWU7XG5cbiAgICAvLyBXb3JrYXJvdW5kIGh0dHBzOi8vZ2l0aHViLmNvbS9iYXplbGJ1aWxkL2JhemVsL2lzc3Vlcy8xMjYyXG4gICAgLy9cbiAgICAvLyBXaGVuIHRoZSBmaWxlIGNvbWVzIGZyb20gYW4gZXh0ZXJuYWwgYmF6ZWwgcmVwb3NpdG9yeSxcbiAgICAvLyBhbmQgVHlwZVNjcmlwdCByZXNvbHZlcyBydW5maWxlcyBzeW1saW5rcywgdGhlbiB0aGUgcGF0aCB3aWxsIGxvb2sgbGlrZVxuICAgIC8vIG91dHB1dF9iYXNlL2V4ZWNyb290L2xvY2FsX3JlcG8vZXh0ZXJuYWwvYW5vdGhlcl9yZXBvL2Zvby9iYXJcbiAgICAvLyBXZSB3YW50IHRvIG5hbWUgc3VjaCBhIG1vZHVsZSBcImFub3RoZXJfcmVwby9mb28vYmFyXCIganVzdCBhcyBpdCB3b3VsZCBiZVxuICAgIC8vIG5hbWVkIGJ5IGNvZGUgaW4gdGhhdCByZXBvc2l0b3J5LlxuICAgIC8vIEFzIGEgd29ya2Fyb3VuZCwgY2hlY2sgZm9yIHRoZSAvZXh0ZXJuYWwvIHBhdGggc2VnbWVudCwgYW5kIGZpeCB1cCB0aGVcbiAgICAvLyB3b3Jrc3BhY2UgbmFtZSB0byBiZSB0aGUgbmFtZSBvZiB0aGUgZXh0ZXJuYWwgcmVwb3NpdG9yeS5cbiAgICBpZiAoZmlsZU5hbWUuc3RhcnRzV2l0aCgnZXh0ZXJuYWwvJykpIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gZmlsZU5hbWUuc3BsaXQoJy8nKTtcbiAgICAgIHdvcmtzcGFjZSA9IHBhcnRzWzFdO1xuICAgICAgZmlsZU5hbWUgPSBwYXJ0cy5zbGljZSgyKS5qb2luKCcvJyk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYmF6ZWxPcHRzLm1vZHVsZU5hbWUpIHtcbiAgICAgIGNvbnN0IHJlbGF0aXZlRmlsZU5hbWUgPSBwYXRoLnBvc2l4LnJlbGF0aXZlKHRoaXMuYmF6ZWxPcHRzLnBhY2thZ2UsIGZpbGVOYW1lKTtcbiAgICAgIGlmICghcmVsYXRpdmVGaWxlTmFtZS5zdGFydHNXaXRoKCcuLicpKSB7XG4gICAgICAgIGlmICh0aGlzLmJhemVsT3B0cy5tb2R1bGVSb290ICYmXG4gICAgICAgICAgICB0aGlzLmJhemVsT3B0cy5tb2R1bGVSb290LnJlcGxhY2UoU09VUkNFX0VYVCwgJycpID09PVxuICAgICAgICAgICAgICAgIHJlbGF0aXZlRmlsZU5hbWUpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5iYXplbE9wdHMubW9kdWxlTmFtZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBTdXBwb3J0IHRoZSBjb21tb24gY2FzZSBvZiBjb21tb25qcyBjb252ZW50aW9uIHRoYXQgaW5kZXggaXMgdGhlXG4gICAgICAgIC8vIGRlZmF1bHQgbW9kdWxlIGluIGEgZGlyZWN0b3J5LlxuICAgICAgICAvLyBUaGlzIG1ha2VzIG91ciBtb2R1bGUgbmFtaW5nIHNjaGVtZSBtb3JlIGNvbnZlbnRpb25hbCBhbmQgbGV0cyB1c2Vyc1xuICAgICAgICAvLyByZWZlciB0byBtb2R1bGVzIHdpdGggdGhlIG5hdHVyYWwgbmFtZSB0aGV5J3JlIHVzZWQgdG8uXG4gICAgICAgIGlmIChyZWxhdGl2ZUZpbGVOYW1lID09PSAnaW5kZXgnKSB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuYmF6ZWxPcHRzLm1vZHVsZU5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHBhdGgucG9zaXguam9pbih0aGlzLmJhemVsT3B0cy5tb2R1bGVOYW1lLCByZWxhdGl2ZUZpbGVOYW1lKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmlsZU5hbWUuc3RhcnRzV2l0aCgnbm9kZV9tb2R1bGVzLycpKSB7XG4gICAgICByZXR1cm4gZmlsZU5hbWUuc3Vic3RyaW5nKCdub2RlX21vZHVsZXMvJy5sZW5ndGgpO1xuICAgIH1cblxuICAgIC8vIHBhdGgvdG8vZmlsZSAtPlxuICAgIC8vIG15V29ya3NwYWNlL3BhdGgvdG8vZmlsZVxuICAgIHJldHVybiBwYXRoLnBvc2l4LmpvaW4od29ya3NwYWNlLCBmaWxlTmFtZSk7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZXMgdGhlIHR5cGluZ3MgZmlsZSBmcm9tIGEgcGFja2FnZSBhdCB0aGUgc3BlY2lmaWVkIHBhdGguIEhlbHBlclxuICAgKiBmdW5jdGlvbiB0byBgcmVzb2x2ZVR5cGVSZWZlcmVuY2VEaXJlY3RpdmVzYC5cbiAgICovXG4gIHByaXZhdGUgcmVzb2x2ZVR5cGluZ0Zyb21EaXJlY3RvcnkodHlwZVBhdGg6IHN0cmluZywgcHJpbWFyeTogYm9vbGVhbik6IHRzLlJlc29sdmVkVHlwZVJlZmVyZW5jZURpcmVjdGl2ZSB8IHVuZGVmaW5lZCB7XG4gICAgLy8gTG9va3MgZm9yIHRoZSBgdHlwaW5nc2AgYXR0cmlidXRlIGluIGEgcGFja2FnZS5qc29uIGZpbGVcbiAgICAvLyBpZiBpdCBleGlzdHNcbiAgICBjb25zdCBwa2dGaWxlID0gcGF0aC5wb3NpeC5qb2luKHR5cGVQYXRoLCAncGFja2FnZS5qc29uJyk7XG4gICAgaWYgKHRoaXMuZmlsZUV4aXN0cyhwa2dGaWxlKSkge1xuICAgICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGtnRmlsZSwgJ1VURi04JykpO1xuICAgICAgbGV0IHR5cGluZ3MgPSBwa2dbJ3R5cGluZ3MnXTtcbiAgICAgIGlmICh0eXBpbmdzKSB7XG4gICAgICAgIGlmICh0eXBpbmdzID09PSAnLicgfHwgdHlwaW5ncyA9PT0gJy4vJykge1xuICAgICAgICAgIHR5cGluZ3MgPSAnaW5kZXguZC50cyc7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbWF5YmUgPSBwYXRoLnBvc2l4LmpvaW4odHlwZVBhdGgsIHR5cGluZ3MpO1xuICAgICAgICBpZiAodGhpcy5maWxlRXhpc3RzKG1heWJlKSkge1xuICAgICAgICAgIHJldHVybiB7IHByaW1hcnksIHJlc29sdmVkRmlsZU5hbWU6IG1heWJlIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBMb29rIGZvciBhbiBpbmRleC5kLnRzIGZpbGUgaW4gdGhlIHBhdGhcbiAgICBjb25zdCBtYXliZSA9IHBhdGgucG9zaXguam9pbih0eXBlUGF0aCwgJ2luZGV4LmQudHMnKTtcbiAgICBpZiAodGhpcy5maWxlRXhpc3RzKG1heWJlKSkge1xuICAgICAgcmV0dXJuIHsgcHJpbWFyeSwgcmVzb2x2ZWRGaWxlTmFtZTogbWF5YmUgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIE92ZXJyaWRlIHRoZSBkZWZhdWx0IHR5cGVzY3JpcHQgcmVzb2x2ZVR5cGVSZWZlcmVuY2VEaXJlY3RpdmVzIGZ1bmN0aW9uLlxuICAgKiBSZXNvbHZlcyAvLy8gPHJlZmVyZW5jZSB0eXBlcz1cInhcIiAvPiBkaXJlY3RpdmVzIHVuZGVyIGJhemVsLiBUaGUgZGVmYXVsdFxuICAgKiB0eXBlc2NyaXB0IHNlY29uZGFyeSBzZWFyY2ggYmVoYXZpb3IgbmVlZHMgdG8gYmUgb3ZlcnJpZGRlbiB0byBzdXBwb3J0XG4gICAqIGxvb2tpbmcgdW5kZXIgYGJhemVsT3B0cy5ub2RlTW9kdWxlc1ByZWZpeGBcbiAgICovXG4gIHJlc29sdmVUeXBlUmVmZXJlbmNlRGlyZWN0aXZlcyhuYW1lczogc3RyaW5nW10sIGNvbnRhaW5pbmdGaWxlOiBzdHJpbmcpOiB0cy5SZXNvbHZlZFR5cGVSZWZlcmVuY2VEaXJlY3RpdmVbXSB7XG4gICAgaWYgKCF0aGlzLmFsbG93QWN0aW9uSW5wdXRSZWFkcykgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHJlc3VsdDogdHMuUmVzb2x2ZWRUeXBlUmVmZXJlbmNlRGlyZWN0aXZlW10gPSBbXTtcbiAgICBuYW1lcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgbGV0IHJlc29sdmVkOiB0cy5SZXNvbHZlZFR5cGVSZWZlcmVuY2VEaXJlY3RpdmUgfCB1bmRlZmluZWQ7XG5cbiAgICAgIC8vIHByaW1hcnkgc2VhcmNoXG4gICAgICB0aGlzLm9wdGlvbnMudHlwZVJvb3RzLmZvckVhY2godHlwZVJvb3QgPT4ge1xuICAgICAgICBpZiAoIXJlc29sdmVkKSB7XG4gICAgICAgICAgcmVzb2x2ZWQgPSB0aGlzLnJlc29sdmVUeXBpbmdGcm9tRGlyZWN0b3J5KHBhdGgucG9zaXguam9pbih0eXBlUm9vdCwgbmFtZSksIHRydWUpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gc2Vjb25kYXJ5IHNlYXJjaFxuICAgICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgICByZXNvbHZlZCA9IHRoaXMucmVzb2x2ZVR5cGluZ0Zyb21EaXJlY3RvcnkocGF0aC5wb3NpeC5qb2luKHRoaXMuYmF6ZWxPcHRzLm5vZGVNb2R1bGVzUHJlZml4LCBuYW1lKSwgZmFsc2UpO1xuICAgICAgfVxuXG4gICAgICAvLyBUeXBlcyBub3QgcmVzb2x2ZWQgc2hvdWxkIGJlIHNpbGVudGx5IGlnbm9yZWQuIExlYXZlIGl0IHRvIFR5cGVzY3JpcHRcbiAgICAgIC8vIHRvIGVpdGhlciBlcnJvciBvdXQgd2l0aCBcIlRTMjY4ODogQ2Fubm90IGZpbmQgdHlwZSBkZWZpbml0aW9uIGZpbGUgZm9yXG4gICAgICAvLyAnZm9vJ1wiIG9yIGZvciB0aGUgYnVpbGQgdG8gZmFpbCBkdWUgdG8gYSBtaXNzaW5nIHR5cGUgdGhhdCBpcyB1c2VkLlxuICAgICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgICBpZiAoREVCVUcpIHtcbiAgICAgICAgICBkZWJ1ZyhgRmFpbGVkIHRvIHJlc29sdmUgdHlwZSByZWZlcmVuY2UgZGlyZWN0aXZlICcke25hbWV9J2ApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIEluIHR5cGVzY3JpcHQgMi54IHRoZSByZXR1cm4gdHlwZSBmb3IgdGhpcyBmdW5jdGlvblxuICAgICAgLy8gaXMgYCh0cy5SZXNvbHZlZFR5cGVSZWZlcmVuY2VEaXJlY3RpdmUgfCB1bmRlZmluZWQpW11gIHRodXMgd2UgYWN0dWFsbHlcbiAgICAgIC8vIGRvIGFsbG93IHJldHVybmluZyBgdW5kZWZpbmVkYCBpbiB0aGUgYXJyYXkgYnV0IHRoZSBmdW5jdGlvbiBpcyB0eXBlZFxuICAgICAgLy8gYCh0cy5SZXNvbHZlZFR5cGVSZWZlcmVuY2VEaXJlY3RpdmUpW11gIHRvIGNvbXBpbGUgd2l0aCBib3RoIHR5cGVzY3JpcHRcbiAgICAgIC8vIDIueCBhbmQgMy4wLzMuMSB3aXRob3V0IGVycm9yLiBUeXBlc2NyaXB0IDMuMC8zLjEgZG8gaGFuZGxlIHRoZSBgdW5kZWZpbmVkYFxuICAgICAgLy8gdmFsdWVzIGluIHRoZSBhcnJheSBjb3JyZWN0bHkgZGVzcGl0ZSB0aGUgcmV0dXJuIHNpZ25hdHVyZS5cbiAgICAgIC8vIEl0IGxvb2tzIGxpa2UgdGhlIHJldHVybiB0eXBlIGNoYW5nZSB3YXMgYSBtaXN0YWtlIGJlY2F1c2VcbiAgICAgIC8vIGl0IHdhcyBjaGFuZ2VkIGJhY2sgdG8gaW5jbHVkZSBgfCB1bmRlZmluZWRgIHJlY2VudGx5OlxuICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL01pY3Jvc29mdC9UeXBlU2NyaXB0L3B1bGwvMjgwNTkuXG4gICAgICByZXN1bHQucHVzaChyZXNvbHZlZCBhcyB0cy5SZXNvbHZlZFR5cGVSZWZlcmVuY2VEaXJlY3RpdmUpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvKiogTG9hZHMgYSBzb3VyY2UgZmlsZSBmcm9tIGRpc2sgKG9yIHRoZSBjYWNoZSkuICovXG4gIGdldFNvdXJjZUZpbGUoXG4gICAgICBmaWxlTmFtZTogc3RyaW5nLCBsYW5ndWFnZVZlcnNpb246IHRzLlNjcmlwdFRhcmdldCxcbiAgICAgIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkKSB7XG4gICAgcmV0dXJuIHBlcmZUcmFjZS53cmFwKGBnZXRTb3VyY2VGaWxlICR7ZmlsZU5hbWV9YCwgKCkgPT4ge1xuICAgICAgY29uc3Qgc2YgPSB0aGlzLmZpbGVMb2FkZXIubG9hZEZpbGUoZmlsZU5hbWUsIGZpbGVOYW1lLCBsYW5ndWFnZVZlcnNpb24pO1xuICAgICAgaWYgKCEvXFwuZFxcLnRzeD8kLy50ZXN0KGZpbGVOYW1lKSAmJlxuICAgICAgICAgICh0aGlzLm9wdGlvbnMubW9kdWxlID09PSB0cy5Nb2R1bGVLaW5kLkFNRCB8fFxuICAgICAgICAgICB0aGlzLm9wdGlvbnMubW9kdWxlID09PSB0cy5Nb2R1bGVLaW5kLlVNRCkpIHtcbiAgICAgICAgY29uc3QgbW9kdWxlTmFtZSA9IHRoaXMuYW1kTW9kdWxlTmFtZShzZik7XG4gICAgICAgIGlmIChzZi5tb2R1bGVOYW1lID09PSBtb2R1bGVOYW1lIHx8ICFtb2R1bGVOYW1lKSByZXR1cm4gc2Y7XG4gICAgICAgIGlmIChzZi5tb2R1bGVOYW1lKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgRVJST1I6ICR7c2YuZmlsZU5hbWV9IGAgK1xuICAgICAgICAgICAgICBgY29udGFpbnMgYSBtb2R1bGUgbmFtZSBkZWNsYXJhdGlvbiAke3NmLm1vZHVsZU5hbWV9IGAgK1xuICAgICAgICAgICAgICBgd2hpY2ggd291bGQgYmUgb3ZlcndyaXR0ZW4gd2l0aCAke21vZHVsZU5hbWV9IGAgK1xuICAgICAgICAgICAgICBgYnkgQmF6ZWwncyBUeXBlU2NyaXB0IGNvbXBpbGVyLmApO1xuICAgICAgICB9XG4gICAgICAgIC8vIFNldHRpbmcgdGhlIG1vZHVsZU5hbWUgaXMgZXF1aXZhbGVudCB0byB0aGUgb3JpZ2luYWwgc291cmNlIGhhdmluZyBhXG4gICAgICAgIC8vIC8vLzxhbWQtbW9kdWxlIG5hbWU9XCJzb21lL25hbWVcIi8+IGRpcmVjdGl2ZVxuICAgICAgICBzZi5tb2R1bGVOYW1lID0gbW9kdWxlTmFtZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZjtcbiAgICB9KTtcbiAgfVxuXG4gIHdyaXRlRmlsZShcbiAgICAgIGZpbGVOYW1lOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZywgd3JpdGVCeXRlT3JkZXJNYXJrOiBib29sZWFuLFxuICAgICAgb25FcnJvcjogKChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQpfHVuZGVmaW5lZCxcbiAgICAgIHNvdXJjZUZpbGVzOiBSZWFkb25seUFycmF5PHRzLlNvdXJjZUZpbGU+fHVuZGVmaW5lZCk6IHZvaWQge1xuICAgIHBlcmZUcmFjZS53cmFwKFxuICAgICAgICBgd3JpdGVGaWxlICR7ZmlsZU5hbWV9YCxcbiAgICAgICAgKCkgPT4gdGhpcy53cml0ZUZpbGVJbXBsKFxuICAgICAgICAgICAgZmlsZU5hbWUsIGNvbnRlbnQsIHdyaXRlQnl0ZU9yZGVyTWFyaywgb25FcnJvciwgc291cmNlRmlsZXMpKTtcbiAgfVxuXG4gIHdyaXRlRmlsZUltcGwoXG4gICAgICBmaWxlTmFtZTogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcsIHdyaXRlQnl0ZU9yZGVyTWFyazogYm9vbGVhbixcbiAgICAgIG9uRXJyb3I6ICgobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkKXx1bmRlZmluZWQsXG4gICAgICBzb3VyY2VGaWxlczogUmVhZG9ubHlBcnJheTx0cy5Tb3VyY2VGaWxlPnx1bmRlZmluZWQpOiB2b2lkIHtcbiAgICAvLyBXb3JrYXJvdW5kIGh0dHBzOi8vZ2l0aHViLmNvbS9NaWNyb3NvZnQvVHlwZVNjcmlwdC9pc3N1ZXMvMTg2NDhcbiAgICAvLyBUaGlzIGJ1ZyBpcyBmaXhlZCBpbiBUUyAyLjlcbiAgICBjb25zdCB2ZXJzaW9uID0gdHMudmVyc2lvbk1ham9yTWlub3I7XG4gICAgY29uc3QgW21ham9yLCBtaW5vcl0gPSB2ZXJzaW9uLnNwbGl0KCcuJykubWFwKHMgPT4gTnVtYmVyKHMpKTtcbiAgICBjb25zdCB3b3JrYXJvdW5kTmVlZGVkID0gbWFqb3IgPD0gMiAmJiBtaW5vciA8PSA4O1xuICAgIGlmICh3b3JrYXJvdW5kTmVlZGVkICYmXG4gICAgICAgICh0aGlzLm9wdGlvbnMubW9kdWxlID09PSB0cy5Nb2R1bGVLaW5kLkFNRCB8fFxuICAgICAgICAgdGhpcy5vcHRpb25zLm1vZHVsZSA9PT0gdHMuTW9kdWxlS2luZC5VTUQpICYmXG4gICAgICAgIGZpbGVOYW1lLmVuZHNXaXRoKCcuZC50cycpICYmIHNvdXJjZUZpbGVzICYmIHNvdXJjZUZpbGVzLmxlbmd0aCA+IDAgJiZcbiAgICAgICAgc291cmNlRmlsZXNbMF0ubW9kdWxlTmFtZSkge1xuICAgICAgY29udGVudCA9XG4gICAgICAgICAgYC8vLyA8YW1kLW1vZHVsZSBuYW1lPVwiJHtzb3VyY2VGaWxlc1swXS5tb2R1bGVOYW1lfVwiIC8+XFxuJHtjb250ZW50fWA7XG4gICAgfVxuICAgIGZpbGVOYW1lID0gdGhpcy5mbGF0dGVuT3V0RGlyKGZpbGVOYW1lKTtcblxuICAgIGlmICh0aGlzLmJhemVsT3B0cy5pc0pzVHJhbnNwaWxhdGlvbikge1xuICAgICAgaWYgKHRoaXMuYmF6ZWxPcHRzLnRyYW5zcGlsZWRKc091dHB1dEZpbGVOYW1lKSB7XG4gICAgICAgIGZpbGVOYW1lID0gdGhpcy5iYXplbE9wdHMudHJhbnNwaWxlZEpzT3V0cHV0RmlsZU5hbWUhO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gU3RyaXAgdGhlIGlucHV0IGRpcmVjdG9yeSBwYXRoIG9mZiBvZiBmaWxlTmFtZSB0byBnZXQgdGhlIGxvZ2ljYWxcbiAgICAgICAgLy8gcGF0aCB3aXRoaW4gdGhlIGlucHV0IGRpcmVjdG9yeS5cbiAgICAgICAgZmlsZU5hbWUgPVxuICAgICAgICAgICAgcGF0aC5yZWxhdGl2ZSh0aGlzLmJhemVsT3B0cy50cmFuc3BpbGVkSnNJbnB1dERpcmVjdG9yeSEsIGZpbGVOYW1lKTtcbiAgICAgICAgLy8gVGhlbiBwcmVwZW5kIHRoZSBvdXRwdXQgZGlyZWN0b3J5IG5hbWUuXG4gICAgICAgIGZpbGVOYW1lID1cbiAgICAgICAgICAgIHBhdGguam9pbih0aGlzLmJhemVsT3B0cy50cmFuc3BpbGVkSnNPdXRwdXREaXJlY3RvcnkhLCBmaWxlTmFtZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICghdGhpcy5iYXplbE9wdHMuZXM1TW9kZSkge1xuICAgICAgLy8gV3JpdGUgRVM2IHRyYW5zcGlsZWQgZmlsZXMgdG8gKi5jbG9zdXJlLmpzLlxuICAgICAgaWYgKHRoaXMuYmF6ZWxPcHRzLmxvY2FsZSkge1xuICAgICAgICAvLyBpMThuIHBhdGhzIGFyZSByZXF1aXJlZCB0byBlbmQgd2l0aCBfX2xvY2FsZS5qcyBzbyB3ZSBwdXRcbiAgICAgICAgLy8gdGhlIC5jbG9zdXJlIHNlZ21lbnQgYmVmb3JlIHRoZSBfX2xvY2FsZVxuICAgICAgICBmaWxlTmFtZSA9IGZpbGVOYW1lLnJlcGxhY2UoLyhfX1teXFwuXSspP1xcLmpzJC8sICcuY2xvc3VyZSQxLmpzJyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmaWxlTmFtZSA9IGZpbGVOYW1lLnJlcGxhY2UoL1xcLmpzJC8sICcuY2xvc3VyZS5qcycpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFByZXBlbmQgdGhlIG91dHB1dCBkaXJlY3RvcnkuXG4gICAgZmlsZU5hbWUgPSBwYXRoLmpvaW4odGhpcy5vcHRpb25zLm91dERpciwgZmlsZU5hbWUpO1xuXG4gICAgLy8gT3VyIGZpbGUgY2FjaGUgaXMgYmFzZWQgb24gbXRpbWUgLSBzbyBhdm9pZCB3cml0aW5nIGZpbGVzIGlmIHRoZXlcbiAgICAvLyBkaWQgbm90IGNoYW5nZS5cbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMoZmlsZU5hbWUpIHx8XG4gICAgICAgIGZzLnJlYWRGaWxlU3luYyhmaWxlTmFtZSwgJ3V0Zi04JykgIT09IGNvbnRlbnQpIHtcbiAgICAgIHRoaXMuZGVsZWdhdGUud3JpdGVGaWxlKFxuICAgICAgICAgIGZpbGVOYW1lLCBjb250ZW50LCB3cml0ZUJ5dGVPcmRlck1hcmssIG9uRXJyb3IsIHNvdXJjZUZpbGVzKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUGVyZm9ybWFuY2Ugb3B0aW1pemF0aW9uOiBkb24ndCB0cnkgdG8gc3RhdCBmaWxlcyB3ZSB3ZXJlbid0IGV4cGxpY2l0bHlcbiAgICogZ2l2ZW4gYXMgaW5wdXRzLlxuICAgKiBUaGlzIGFsc28gYWxsb3dzIHVzIHRvIGRpc2FibGUgQmF6ZWwgc2FuZGJveGluZywgd2l0aG91dCBhY2NpZGVudGFsbHlcbiAgICogcmVhZGluZyAudHMgaW5wdXRzIHdoZW4gLmQudHMgaW5wdXRzIGFyZSBpbnRlbmRlZC5cbiAgICogTm90ZSB0aGF0IGluIHdvcmtlciBtb2RlLCB0aGUgZmlsZSBjYWNoZSB3aWxsIGFsc28gZ3VhcmQgYWdhaW5zdCBhcmJpdHJhcnlcbiAgICogZmlsZSByZWFkcy5cbiAgICovXG4gIGZpbGVFeGlzdHMoZmlsZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIC8vIFVuZGVyIEJhemVsLCB1c2VycyBkbyBub3QgZGVjbGFyZSBkZXBzW10gb24gdGhlaXIgbm9kZV9tb2R1bGVzLlxuICAgIC8vIFRoaXMgbWVhbnMgdGhhdCB3ZSBkbyBub3QgbGlzdCBhbGwgdGhlIG5lZWRlZCAuZC50cyBmaWxlcyBpbiB0aGUgZmlsZXNbXVxuICAgIC8vIHNlY3Rpb24gb2YgdHNjb25maWcuanNvbiwgYW5kIHRoYXQgaXMgd2hhdCBwb3B1bGF0ZXMgdGhlIGtub3duRmlsZXMgc2V0LlxuICAgIC8vIEluIGFkZGl0aW9uLCB0aGUgbm9kZSBtb2R1bGUgcmVzb2x2ZXIgbWF5IG5lZWQgdG8gcmVhZCBwYWNrYWdlLmpzb24gZmlsZXNcbiAgICAvLyBhbmQgdGhlc2UgYXJlIG5vdCBwZXJtaXR0ZWQgaW4gdGhlIGZpbGVzW10gc2VjdGlvbi5cbiAgICAvLyBTbyB3ZSBwZXJtaXQgcmVhZGluZyBub2RlX21vZHVsZXMvKiBmcm9tIGFjdGlvbiBpbnB1dHMsIGV2ZW4gdGhvdWdoIHRoaXNcbiAgICAvLyBjYW4gaW5jbHVkZSBkYXRhW10gZGVwZW5kZW5jaWVzIGFuZCBpcyBicm9hZGVyIHRoYW4gd2Ugd291bGQgbGlrZS5cbiAgICAvLyBUaGlzIHNob3VsZCBvbmx5IGJlIGVuYWJsZWQgdW5kZXIgQmF6ZWwsIG5vdCBCbGF6ZS5cbiAgICBpZiAodGhpcy5hbGxvd0FjdGlvbklucHV0UmVhZHMgJiYgZmlsZVBhdGguaW5kZXhPZignL25vZGVfbW9kdWxlcy8nKSA+PSAwKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSB0aGlzLmZpbGVMb2FkZXIuZmlsZUV4aXN0cyhmaWxlUGF0aCk7XG4gICAgICBpZiAoREVCVUcgJiYgIXJlc3VsdCAmJiB0aGlzLmRlbGVnYXRlLmZpbGVFeGlzdHMoZmlsZVBhdGgpKSB7XG4gICAgICAgIGRlYnVnKFwiUGF0aCBleGlzdHMsIGJ1dCBpcyBub3QgcmVnaXN0ZXJlZCBpbiB0aGUgY2FjaGVcIiwgZmlsZVBhdGgpO1xuICAgICAgICBPYmplY3Qua2V5cygodGhpcy5maWxlTG9hZGVyIGFzIGFueSkuY2FjaGUubGFzdERpZ2VzdHMpLmZvckVhY2goayA9PiB7XG4gICAgICAgICAgaWYgKGsuZW5kc1dpdGgocGF0aC5iYXNlbmFtZShmaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICBkZWJ1ZyhcIiAgTWF5YmUgeW91IG1lYW50IHRvIGxvYWQgZnJvbVwiLCBrKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMua25vd25GaWxlcy5oYXMoZmlsZVBhdGgpO1xuICB9XG5cbiAgZ2V0RGVmYXVsdExpYkxvY2F0aW9uKCk6IHN0cmluZyB7XG4gICAgLy8gU2luY2Ugd2Ugb3ZlcnJpZGUgZ2V0RGVmYXVsdExpYkZpbGVOYW1lIGJlbG93LCB3ZSBtdXN0IGFsc28gcHJvdmlkZSB0aGVcbiAgICAvLyBkaXJlY3RvcnkgY29udGFpbmluZyB0aGUgZmlsZS5cbiAgICAvLyBPdGhlcndpc2UgVHlwZVNjcmlwdCBsb29rcyBpbiBDOlxcbGliLnh4eC5kLnRzIGZvciB0aGUgZGVmYXVsdCBsaWIuXG4gICAgcmV0dXJuIHBhdGguZGlybmFtZShcbiAgICAgICAgdGhpcy5nZXREZWZhdWx0TGliRmlsZU5hbWUoe3RhcmdldDogdHMuU2NyaXB0VGFyZ2V0LkVTNX0pKTtcbiAgfVxuXG4gIGdldERlZmF1bHRMaWJGaWxlTmFtZShvcHRpb25zOiB0cy5Db21waWxlck9wdGlvbnMpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLmJhemVsT3B0cy5ub2RlTW9kdWxlc1ByZWZpeCkge1xuICAgICAgcmV0dXJuIHBhdGguam9pbihcbiAgICAgICAgICB0aGlzLmJhemVsT3B0cy5ub2RlTW9kdWxlc1ByZWZpeCwgJ3R5cGVzY3JpcHQvbGliJyxcbiAgICAgICAgICB0cy5nZXREZWZhdWx0TGliRmlsZU5hbWUoe3RhcmdldDogdHMuU2NyaXB0VGFyZ2V0LkVTNX0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuZGVsZWdhdGUuZ2V0RGVmYXVsdExpYkZpbGVOYW1lKG9wdGlvbnMpO1xuICB9XG5cbiAgcmVhbHBhdGgoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICAvLyB0c2Mtd3JhcHBlZCByZWxpZXMgb24gc3RyaW5nIG1hdGNoaW5nIG9mIGZpbGUgcGF0aHMgZm9yIHRoaW5ncyBsaWtlIHRoZVxuICAgIC8vIGZpbGUgY2FjaGUgYW5kIGZvciBzdHJpY3QgZGVwcyBjaGVja2luZy5cbiAgICAvLyBUeXBlU2NyaXB0IHdpbGwgdHJ5IHRvIHJlc29sdmUgc3ltbGlua3MgZHVyaW5nIG1vZHVsZSByZXNvbHV0aW9uIHdoaWNoXG4gICAgLy8gbWFrZXMgb3VyIGNoZWNrcyBmYWlsOiB0aGUgcGF0aCB3ZSByZXNvbHZlZCBhcyBhbiBpbnB1dCBpc24ndCB0aGUgc2FtZVxuICAgIC8vIG9uZSB0aGUgbW9kdWxlIHJlc29sdmVyIHdpbGwgbG9vayBmb3IuXG4gICAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9NaWNyb3NvZnQvVHlwZVNjcmlwdC9wdWxsLzEyMDIwXG4gICAgLy8gU28gd2Ugc2ltcGx5IHR1cm4gb2ZmIHN5bWxpbmsgcmVzb2x1dGlvbi5cbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8vIERlbGVnYXRlIGV2ZXJ5dGhpbmcgZWxzZSB0byB0aGUgb3JpZ2luYWwgY29tcGlsZXIgaG9zdC5cblxuICBnZXRDYW5vbmljYWxGaWxlTmFtZShwYXRoOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5nZXRDYW5vbmljYWxGaWxlTmFtZShwYXRoKTtcbiAgfVxuXG4gIGdldEN1cnJlbnREaXJlY3RvcnkoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5nZXRDdXJyZW50RGlyZWN0b3J5KCk7XG4gIH1cblxuICB1c2VDYXNlU2Vuc2l0aXZlRmlsZU5hbWVzKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmRlbGVnYXRlLnVzZUNhc2VTZW5zaXRpdmVGaWxlTmFtZXMoKTtcbiAgfVxuXG4gIGdldE5ld0xpbmUoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5nZXROZXdMaW5lKCk7XG4gIH1cblxuICBnZXREaXJlY3RvcmllcyhwYXRoOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5kZWxlZ2F0ZS5nZXREaXJlY3RvcmllcyA/IHRoaXMuZGVsZWdhdGUuZ2V0RGlyZWN0b3JpZXMocGF0aCkgOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW107XG4gIH1cblxuICByZWFkRmlsZShmaWxlTmFtZTogc3RyaW5nKTogc3RyaW5nfHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuZGVsZWdhdGUucmVhZEZpbGUoZmlsZU5hbWUpO1xuICB9XG5cbiAgdHJhY2Uoczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc29sZS5lcnJvcihzKTtcbiAgfVxufVxuIl19