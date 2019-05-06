(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "path", "protobufjs"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const path = require("path");
    const protobufjs = require("protobufjs");
    // Equivalent of running node with --expose-gc
    // but easier to write tooling since we don't need to inject that arg to
    // nodejs_binary
    if (typeof global.gc !== 'function') {
        // tslint:disable-next-line:no-require-imports
        require('v8').setFlagsFromString('--expose_gc');
        // tslint:disable-next-line:no-require-imports
        global.gc = require('vm').runInNewContext('gc');
    }
    /**
     * Whether to print debug messages (to console.error) from the debug function
     * below.
     */
    exports.DEBUG = false;
    /** Maybe print a debug message (depending on a flag defaulting to false). */
    function debug(...args) {
        if (exports.DEBUG)
            console.error.apply(console, args);
    }
    exports.debug = debug;
    /**
     * Write a message to stderr, which appears in the bazel log and is visible to
     * the end user.
     */
    function log(...args) {
        console.error.apply(console, args);
    }
    exports.log = log;
    /**
     * runAsWorker returns true if the given arguments indicate the process should
     * run as a persistent worker.
     */
    function runAsWorker(args) {
        return args.indexOf('--persistent_worker') !== -1;
    }
    exports.runAsWorker = runAsWorker;
    /**
     * loadWorkerPb finds and loads the protocol buffer definition for bazel's
     * worker protocol using protobufjs. In protobufjs, this means it's a reflection
     * object that also contains properties for the individual messages.
     */
    function loadWorkerPb() {
        const protoPath = '../worker_protocol.proto';
        // Use node module resolution so we can find the .proto file in any of the
        // root dirs
        let protofile;
        try {
            // Look for the .proto file relative in its @bazel/typescript npm package
            // location
            protofile = require.resolve(protoPath);
        }
        catch (e) {
        }
        if (!protofile) {
            // If not found above, look for the .proto file in its rules_typescript
            // workspace location
            // This extra lookup should never happen in google3. It's only needed for
            // local development in the rules_typescript repo.
            protofile = require.resolve('../../third_party/github.com/bazelbuild/bazel/src/main/protobuf/worker_protocol.proto');
        }
        const protoNamespace = protobufjs.loadSync(protofile);
        if (!protoNamespace) {
            throw new Error('Cannot find ' + path.resolve(protoPath));
        }
        const workerpb = protoNamespace.lookup('blaze.worker');
        if (!workerpb) {
            throw new Error(`Cannot find namespace blaze.worker`);
        }
        return workerpb;
    }
    /**
     * workerpb contains the runtime representation of the worker protocol buffer,
     * including accessor for the defined messages.
     */
    const workerpb = loadWorkerPb();
    /**
     * runWorkerLoop handles the interacton between bazel workers and the
     * TypeScript compiler. It reads compilation requests from stdin, unmarshals the
     * data, and dispatches into `runOneBuild` for the actual compilation to happen.
     *
     * The compilation handler is parameterized so that this code can be used by
     * different compiler entry points (currently TypeScript compilation and Angular
     * compilation).
     */
    function runWorkerLoop(runOneBuild) {
        // Hook all output to stderr and write it to a buffer, then include
        // that buffer's in the worker protcol proto's textual output.  This
        // means you can log via console.error() and it will appear to the
        // user as expected.
        let consoleOutput = '';
        process.stderr.write =
            (chunk, ...otherArgs) => {
                consoleOutput += chunk.toString();
                return true;
            };
        // Accumulator for asynchronously read input.
        // protobufjs uses node's Buffer, but has its own reader abstraction on top of
        // it (for browser compatiblity). It ignores Buffer's builtin start and
        // offset, which means the handling code below cannot use Buffer in a
        // meaningful way (such as cycling data through it). The handler below reads
        // any data available on stdin, concatenating it into this buffer. It then
        // attempts to read a delimited Message from it. If a message is incomplete,
        // it exits and waits for more input. If a message has been read, it strips
        // its data of this buffer.
        let buf = Buffer.alloc(0);
        process.stdin.on('readable', () => {
            const chunk = process.stdin.read();
            if (!chunk)
                return;
            buf = Buffer.concat([buf, chunk]);
            try {
                const reader = new protobufjs.Reader(buf);
                // Read all requests that have accumulated in the buffer.
                while (reader.len - reader.pos > 0) {
                    const messageStart = reader.len;
                    const msgLength = reader.uint32();
                    // chunk might be an incomplete read from stdin. If there are not enough
                    // bytes for the next full message, wait for more input.
                    if ((reader.len - reader.pos) < msgLength)
                        return;
                    const req = workerpb.WorkRequest.decode(reader, msgLength);
                    // Once a message has been read, remove it from buf so that if we pause
                    // to read more input, this message will not be processed again.
                    buf = buf.slice(messageStart);
                    debug('=== Handling new build request');
                    // Reset accumulated log output.
                    consoleOutput = '';
                    const args = req.arguments;
                    const inputs = {};
                    for (const input of req.inputs) {
                        inputs[input.path] = input.digest.toString('hex');
                    }
                    debug('Compiling with:\n\t' + args.join('\n\t'));
                    const exitCode = runOneBuild(args, inputs) ? 0 : 1;
                    process.stdout.write((workerpb.WorkResponse.encodeDelimited({
                        exitCode,
                        output: consoleOutput,
                    })).finish());
                    // Force a garbage collection pass.  This keeps our memory usage
                    // consistent across multiple compilations, and allows the file
                    // cache to use the current memory usage as a guideline for expiring
                    // data.  Note: this is intentionally not within runOneBuild(), as
                    // we want to gc only after all its locals have gone out of scope.
                    global.gc();
                }
                // All messages have been handled, make sure the invariant holds and
                // Buffer is empty once all messages have been read.
                if (buf.length > 0) {
                    throw new Error('buffer not empty after reading all messages');
                }
            }
            catch (e) {
                log('Compilation failed', e.stack);
                process.stdout.write(workerpb.WorkResponse
                    .encodeDelimited({ exitCode: 1, output: consoleOutput })
                    .finish());
                // Clear buffer so the next build won't read an incomplete request.
                buf = Buffer.alloc(0);
            }
        });
    }
    exports.runWorkerLoop = runWorkerLoop;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vZXh0ZXJuYWwvYnVpbGRfYmF6ZWxfcnVsZXNfdHlwZXNjcmlwdC9pbnRlcm5hbC90c2Nfd3JhcHBlZC93b3JrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7SUFBQSw2QkFBNkI7SUFDN0IseUNBQXlDO0lBRXpDLDhDQUE4QztJQUM5Qyx3RUFBd0U7SUFDeEUsZ0JBQWdCO0lBQ2hCLElBQUksT0FBTyxNQUFNLENBQUMsRUFBRSxLQUFLLFVBQVUsRUFBRTtRQUNuQyw4Q0FBOEM7UUFDOUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ2hELDhDQUE4QztRQUM5QyxNQUFNLENBQUMsRUFBRSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7S0FDakQ7SUFFRDs7O09BR0c7SUFDVSxRQUFBLEtBQUssR0FBRyxLQUFLLENBQUM7SUFFM0IsNkVBQTZFO0lBQzdFLFNBQWdCLEtBQUssQ0FBQyxHQUFHLElBQW9CO1FBQzNDLElBQUksYUFBSztZQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNoRCxDQUFDO0lBRkQsc0JBRUM7SUFFRDs7O09BR0c7SUFDSCxTQUFnQixHQUFHLENBQUMsR0FBRyxJQUFvQjtRQUN6QyxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUZELGtCQUVDO0lBRUQ7OztPQUdHO0lBQ0gsU0FBZ0IsV0FBVyxDQUFDLElBQWM7UUFDeEMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUZELGtDQUVDO0lB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NkNBQTZDLENBQUMsQ0FBQztpQkFDaEU7YUFDRjtZQUFDLE9BQU8sQ0FBQyxFQUFFO2dCQUNWLEdBQUcsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ25DLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUNoQixRQUFRLENBQUMsWUFBWTtxQkFDaEIsZUFBZSxDQUFDLEVBQUMsUUFBUSxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFDLENBQUM7cUJBQ3JELE1BQU0sRUFBWSxDQUFDLENBQUM7Z0JBQzdCLG1FQUFtRTtnQkFDbkUsR0FBRyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDdkI7UUFDSCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUEvRUQsc0NBK0VDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIHByb3RvYnVmanMgZnJvbSAncHJvdG9idWZqcyc7XG5cbi8vIEVxdWl2YWxlbnQgb2YgcnVubmluZyBub2RlIHdpdGggLS1leHBvc2UtZ2Ncbi8vIGJ1dCBlYXNpZXIgdG8gd3JpdGUgdG9vbGluZyBzaW5jZSB3ZSBkb24ndCBuZWVkIHRvIGluamVjdCB0aGF0IGFyZyB0b1xuLy8gbm9kZWpzX2JpbmFyeVxuaWYgKHR5cGVvZiBnbG9iYWwuZ2MgIT09ICdmdW5jdGlvbicpIHtcbiAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLXJlcXVpcmUtaW1wb3J0c1xuICByZXF1aXJlKCd2OCcpLnNldEZsYWdzRnJvbVN0cmluZygnLS1leHBvc2VfZ2MnKTtcbiAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLXJlcXVpcmUtaW1wb3J0c1xuICBnbG9iYWwuZ2MgPSByZXF1aXJlKCd2bScpLnJ1bkluTmV3Q29udGV4dCgnZ2MnKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRvIHByaW50IGRlYnVnIG1lc3NhZ2VzICh0byBjb25zb2xlLmVycm9yKSBmcm9tIHRoZSBkZWJ1ZyBmdW5jdGlvblxuICogYmVsb3cuXG4gKi9cbmV4cG9ydCBjb25zdCBERUJVRyA9IGZhbHNlO1xuXG4vKiogTWF5YmUgcHJpbnQgYSBkZWJ1ZyBtZXNzYWdlIChkZXBlbmRpbmcgb24gYSBmbGFnIGRlZmF1bHRpbmcgdG8gZmFsc2UpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlYnVnKC4uLmFyZ3M6IEFycmF5PHVua25vd24+KSB7XG4gIGlmIChERUJVRykgY29uc29sZS5lcnJvci5hcHBseShjb25zb2xlLCBhcmdzKTtcbn1cblxuLyoqXG4gKiBXcml0ZSBhIG1lc3NhZ2UgdG8gc3RkZXJyLCB3aGljaCBhcHBlYXJzIGluIHRoZSBiYXplbCBsb2cgYW5kIGlzIHZpc2libGUgdG9cbiAqIHRoZSBlbmQgdXNlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvZyguLi5hcmdzOiBBcnJheTx1bmtub3duPikge1xuICBjb25zb2xlLmVycm9yLmFwcGx5KGNvbnNvbGUsIGFyZ3MpO1xufVxuXG4vKipcbiAqIHJ1bkFzV29ya2VyIHJldHVybnMgdHJ1ZSBpZiB0aGUgZ2l2ZW4gYXJndW1lbnRzIGluZGljYXRlIHRoZSBwcm9jZXNzIHNob3VsZFxuICogcnVuIGFzIGEgcGVyc2lzdGVudCB3b3JrZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5Bc1dvcmtlcihhcmdzOiBzdHJpbmdbXSkge1xuICByZXR1cm4gYXJncy5pbmRleE9mKCctLXBlcnNpc3RlbnRfd29ya2VyJykgIT09IC0xO1xufVxuXG4vKipcbiAqIHdvcmtlclByb3RvIGRlY2xhcmVzIHRoZSBzdGF0aWMgdHlwZSBvZiB0aGUgb2JqZWN0IGNvbnN0cnVjdGVkIGF0IHJ1bnRpbWUgYnlcbiAqIHByb3RvYnVmanMsIGJhc2VkIG9uIHJlYWRpbmcgdGhlIHByb3RvY29sIGJ1ZmZlciBkZWZpbml0aW9uLlxuICovXG5kZWNsYXJlIG5hbWVzcGFjZSB3b3JrZXJQcm90byB7XG4gIC8qKiBJbnB1dCByZXByZXNlbnRzIHRoZSBibGF6ZS53b3JrZXIuSW5wdXQgbWVzc2FnZS4gKi9cbiAgaW50ZXJmYWNlIElucHV0IGV4dGVuZHMgcHJvdG9idWZqcy5NZXNzYWdlPElucHV0PiB7XG4gICAgcGF0aDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIEluIE5vZGUsIGRpZ2VzdCBpcyBhIEJ1ZmZlci4gSW4gdGhlIGJyb3dzZXIsIGl0J3MgYSByZXBsYWNlbWVudFxuICAgICAqIGltcGxlbWVudGF0aW9uLiBXZSBvbmx5IGNhcmUgYWJvdXQgaXRzIHRvU3RyaW5nKGVuY29kaW5nKSBtZXRob2QuXG4gICAgICovXG4gICAgZGlnZXN0OiB7dG9TdHJpbmcoZW5jb2Rpbmc6IHN0cmluZyk6IHN0cmluZ307XG4gIH1cblxuICAvKiogV29ya1JlcXVlc3QgcmVwZXNlbnRzIHRoZSBibGF6ZS53b3JrZXIuV29ya1JlcXVlc3QgbWVzc2FnZS4gKi9cbiAgaW50ZXJmYWNlIFdvcmtSZXF1ZXN0IGV4dGVuZHMgcHJvdG9idWZqcy5NZXNzYWdlPFdvcmtSZXF1ZXN0PiB7XG4gICAgYXJndW1lbnRzOiBzdHJpbmdbXTtcbiAgICBpbnB1dHM6IElucHV0W107XG4gIH1cblxuICAvLyB0c2xpbnQ6ZGlzYWJsZTp2YXJpYWJsZS1uYW1lIHJlZmxlY3RlZCwgY29uc3RydWN0YWJsZSB0eXBlcy5cbiAgY29uc3QgV29ya1JlcXVlc3Q6IHByb3RvYnVmanMuVHlwZTtcbiAgY29uc3QgV29ya1Jlc3BvbnNlOiBwcm90b2J1ZmpzLlR5cGU7XG4gIC8vIHRzbGludDplbmFibGU6dmFyaWFibGUtbmFtZVxufVxuXG4vKipcbiAqIGxvYWRXb3JrZXJQYiBmaW5kcyBhbmQgbG9hZHMgdGhlIHByb3RvY29sIGJ1ZmZlciBkZWZpbml0aW9uIGZvciBiYXplbCdzXG4gKiB3b3JrZXIgcHJvdG9jb2wgdXNpbmcgcHJvdG9idWZqcy4gSW4gcHJvdG9idWZqcywgdGhpcyBtZWFucyBpdCdzIGEgcmVmbGVjdGlvblxuICogb2JqZWN0IHRoYXQgYWxzbyBjb250YWlucyBwcm9wZXJ0aWVzIGZvciB0aGUgaW5kaXZpZHVhbCBtZXNzYWdlcy5cbiAqL1xuZnVuY3Rpb24gbG9hZFdvcmtlclBiKCkge1xuICBjb25zdCBwcm90b1BhdGggPVxuICAgICAgJy4uL3dvcmtlcl9wcm90b2NvbC5wcm90byc7XG5cbiAgLy8gVXNlIG5vZGUgbW9kdWxlIHJlc29sdXRpb24gc28gd2UgY2FuIGZpbmQgdGhlIC5wcm90byBmaWxlIGluIGFueSBvZiB0aGVcbiAgLy8gcm9vdCBkaXJzXG4gIGxldCBwcm90b2ZpbGU7XG4gIHRyeSB7XG4gICAgLy8gTG9vayBmb3IgdGhlIC5wcm90byBmaWxlIHJlbGF0aXZlIGluIGl0cyBAYmF6ZWwvdHlwZXNjcmlwdCBucG0gcGFja2FnZVxuICAgIC8vIGxvY2F0aW9uXG4gICAgcHJvdG9maWxlID0gcmVxdWlyZS5yZXNvbHZlKHByb3RvUGF0aCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgfVxuICBpZiAoIXByb3RvZmlsZSkge1xuICAgIC8vIElmIG5vdCBmb3VuZCBhYm92ZSwgbG9vayBmb3IgdGhlIC5wcm90byBmaWxlIGluIGl0cyBydWxlc190eXBlc2NyaXB0XG4gICAgLy8gd29ya3NwYWNlIGxvY2F0aW9uXG4gICAgLy8gVGhpcyBleHRyYSBsb29rdXAgc2hvdWxkIG5ldmVyIGhhcHBlbiBpbiBnb29nbGUzLiBJdCdzIG9ubHkgbmVlZGVkIGZvclxuICAgIC8vIGxvY2FsIGRldmVsb3BtZW50IGluIHRoZSBydWxlc190eXBlc2NyaXB0IHJlcG8uXG4gICAgcHJvdG9maWxlID0gcmVxdWlyZS5yZXNvbHZlKFxuICAgICAgICAnLi4vLi4vdGhpcmRfcGFydHkvZ2l0aHViLmNvbS9iYXplbGJ1aWxkL2JhemVsL3NyYy9tYWluL3Byb3RvYnVmL3dvcmtlcl9wcm90b2NvbC5wcm90bycpO1xuICB9XG5cbiAgY29uc3QgcHJvdG9OYW1lc3BhY2UgPSBwcm90b2J1ZmpzLmxvYWRTeW5jKHByb3RvZmlsZSk7XG4gIGlmICghcHJvdG9OYW1lc3BhY2UpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBmaW5kICcgKyBwYXRoLnJlc29sdmUocHJvdG9QYXRoKSk7XG4gIH1cbiAgY29uc3Qgd29ya2VycGIgPSBwcm90b05hbWVzcGFjZS5sb29rdXAoJ2JsYXplLndvcmtlcicpO1xuICBpZiAoIXdvcmtlcnBiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBuYW1lc3BhY2UgYmxhemUud29ya2VyYCk7XG4gIH1cbiAgcmV0dXJuIHdvcmtlcnBiIGFzIHByb3RvYnVmanMuUmVmbGVjdGlvbk9iamVjdCAmIHR5cGVvZiB3b3JrZXJQcm90bztcbn1cblxuLyoqXG4gKiB3b3JrZXJwYiBjb250YWlucyB0aGUgcnVudGltZSByZXByZXNlbnRhdGlvbiBvZiB0aGUgd29ya2VyIHByb3RvY29sIGJ1ZmZlcixcbiAqIGluY2x1ZGluZyBhY2Nlc3NvciBmb3IgdGhlIGRlZmluZWQgbWVzc2FnZXMuXG4gKi9cbmNvbnN0IHdvcmtlcnBiID0gbG9hZFdvcmtlclBiKCk7XG5cbi8qKlxuICogcnVuV29ya2VyTG9vcCBoYW5kbGVzIHRoZSBpbnRlcmFjdG9uIGJldHdlZW4gYmF6ZWwgd29ya2VycyBhbmQgdGhlXG4gKiBUeXBlU2NyaXB0IGNvbXBpbGVyLiBJdCByZWFkcyBjb21waWxhdGlvbiByZXF1ZXN0cyBmcm9tIHN0ZGluLCB1bm1hcnNoYWxzIHRoZVxuICogZGF0YSwgYW5kIGRpc3BhdGNoZXMgaW50byBgcnVuT25lQnVpbGRgIGZvciB0aGUgYWN0dWFsIGNvbXBpbGF0aW9uIHRvIGhhcHBlbi5cbiAqXG4gKiBUaGUgY29tcGlsYXRpb24gaGFuZGxlciBpcyBwYXJhbWV0ZXJpemVkIHNvIHRoYXQgdGhpcyBjb2RlIGNhbiBiZSB1c2VkIGJ5XG4gKiBkaWZmZXJlbnQgY29tcGlsZXIgZW50cnkgcG9pbnRzIChjdXJyZW50bHkgVHlwZVNjcmlwdCBjb21waWxhdGlvbiBhbmQgQW5ndWxhclxuICogY29tcGlsYXRpb24pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVuV29ya2VyTG9vcChcbiAgICBydW5PbmVCdWlsZDogKGFyZ3M6IHN0cmluZ1tdLCBpbnB1dHM/OiB7W3BhdGg6IHN0cmluZ106IHN0cmluZ30pID0+XG4gICAgICAgIGJvb2xlYW4pIHtcbiAgLy8gSG9vayBhbGwgb3V0cHV0IHRvIHN0ZGVyciBhbmQgd3JpdGUgaXQgdG8gYSBidWZmZXIsIHRoZW4gaW5jbHVkZVxuICAvLyB0aGF0IGJ1ZmZlcidzIGluIHRoZSB3b3JrZXIgcHJvdGNvbCBwcm90bydzIHRleHR1YWwgb3V0cHV0LiAgVGhpc1xuICAvLyBtZWFucyB5b3UgY2FuIGxvZyB2aWEgY29uc29sZS5lcnJvcigpIGFuZCBpdCB3aWxsIGFwcGVhciB0byB0aGVcbiAgLy8gdXNlciBhcyBleHBlY3RlZC5cbiAgbGV0IGNvbnNvbGVPdXRwdXQgPSAnJztcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUgPVxuICAgICAgKGNodW5rOiBzdHJpbmd8QnVmZmVyLCAuLi5vdGhlckFyZ3M6IEFycmF5PHVua25vd24+KTogYm9vbGVhbiA9PiB7XG4gICAgICAgIGNvbnNvbGVPdXRwdXQgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9O1xuXG4gIC8vIEFjY3VtdWxhdG9yIGZvciBhc3luY2hyb25vdXNseSByZWFkIGlucHV0LlxuICAvLyBwcm90b2J1ZmpzIHVzZXMgbm9kZSdzIEJ1ZmZlciwgYnV0IGhhcyBpdHMgb3duIHJlYWRlciBhYnN0cmFjdGlvbiBvbiB0b3Agb2ZcbiAgLy8gaXQgKGZvciBicm93c2VyIGNvbXBhdGlibGl0eSkuIEl0IGlnbm9yZXMgQnVmZmVyJ3MgYnVpbHRpbiBzdGFydCBhbmRcbiAgLy8gb2Zmc2V0LCB3aGljaCBtZWFucyB0aGUgaGFuZGxpbmcgY29kZSBiZWxvdyBjYW5ub3QgdXNlIEJ1ZmZlciBpbiBhXG4gIC8vIG1lYW5pbmdmdWwgd2F5IChzdWNoIGFzIGN5Y2xpbmcgZGF0YSB0aHJvdWdoIGl0KS4gVGhlIGhhbmRsZXIgYmVsb3cgcmVhZHNcbiAgLy8gYW55IGRhdGEgYXZhaWxhYmxlIG9uIHN0ZGluLCBjb25jYXRlbmF0aW5nIGl0IGludG8gdGhpcyBidWZmZXIuIEl0IHRoZW5cbiAgLy8gYXR0ZW1wdHMgdG8gcmVhZCBhIGRlbGltaXRlZCBNZXNzYWdlIGZyb20gaXQuIElmIGEgbWVzc2FnZSBpcyBpbmNvbXBsZXRlLFxuICAvLyBpdCBleGl0cyBhbmQgd2FpdHMgZm9yIG1vcmUgaW5wdXQuIElmIGEgbWVzc2FnZSBoYXMgYmVlbiByZWFkLCBpdCBzdHJpcHNcbiAgLy8gaXRzIGRhdGEgb2YgdGhpcyBidWZmZXIuXG4gIGxldCBidWY6IEJ1ZmZlciA9IEJ1ZmZlci5hbGxvYygwKTtcbiAgcHJvY2Vzcy5zdGRpbi5vbigncmVhZGFibGUnLCAoKSA9PiB7XG4gICAgY29uc3QgY2h1bmsgPSBwcm9jZXNzLnN0ZGluLnJlYWQoKSBhcyBCdWZmZXI7XG4gICAgaWYgKCFjaHVuaykgcmV0dXJuO1xuICAgIGJ1ZiA9IEJ1ZmZlci5jb25jYXQoW2J1ZiwgY2h1bmtdKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVhZGVyID0gbmV3IHByb3RvYnVmanMuUmVhZGVyKGJ1Zik7XG4gICAgICAvLyBSZWFkIGFsbCByZXF1ZXN0cyB0aGF0IGhhdmUgYWNjdW11bGF0ZWQgaW4gdGhlIGJ1ZmZlci5cbiAgICAgIHdoaWxlIChyZWFkZXIubGVuIC0gcmVhZGVyLnBvcyA+IDApIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZVN0YXJ0ID0gcmVhZGVyLmxlbjtcbiAgICAgICAgY29uc3QgbXNnTGVuZ3RoOiBudW1iZXIgPSByZWFkZXIudWludDMyKCk7XG4gICAgICAgIC8vIGNodW5rIG1pZ2h0IGJlIGFuIGluY29tcGxldGUgcmVhZCBmcm9tIHN0ZGluLiBJZiB0aGVyZSBhcmUgbm90IGVub3VnaFxuICAgICAgICAvLyBieXRlcyBmb3IgdGhlIG5leHQgZnVsbCBtZXNzYWdlLCB3YWl0IGZvciBtb3JlIGlucHV0LlxuICAgICAgICBpZiAoKHJlYWRlci5sZW4gLSByZWFkZXIucG9zKSA8IG1zZ0xlbmd0aCkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IHJlcSA9IHdvcmtlcnBiLldvcmtSZXF1ZXN0LmRlY29kZShyZWFkZXIsIG1zZ0xlbmd0aCkgYXNcbiAgICAgICAgICAgIHdvcmtlclByb3RvLldvcmtSZXF1ZXN0O1xuICAgICAgICAvLyBPbmNlIGEgbWVzc2FnZSBoYXMgYmVlbiByZWFkLCByZW1vdmUgaXQgZnJvbSBidWYgc28gdGhhdCBpZiB3ZSBwYXVzZVxuICAgICAgICAvLyB0byByZWFkIG1vcmUgaW5wdXQsIHRoaXMgbWVzc2FnZSB3aWxsIG5vdCBiZSBwcm9jZXNzZWQgYWdhaW4uXG4gICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShtZXNzYWdlU3RhcnQpO1xuICAgICAgICBkZWJ1ZygnPT09IEhhbmRsaW5nIG5ldyBidWlsZCByZXF1ZXN0Jyk7XG4gICAgICAgIC8vIFJlc2V0IGFjY3VtdWxhdGVkIGxvZyBvdXRwdXQuXG4gICAgICAgIGNvbnNvbGVPdXRwdXQgPSAnJztcbiAgICAgICAgY29uc3QgYXJncyA9IHJlcS5hcmd1bWVudHM7XG4gICAgICAgIGNvbnN0IGlucHV0czoge1twYXRoOiBzdHJpbmddOiBzdHJpbmd9ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgaW5wdXQgb2YgcmVxLmlucHV0cykge1xuICAgICAgICAgIGlucHV0c1tpbnB1dC5wYXRoXSA9IGlucHV0LmRpZ2VzdC50b1N0cmluZygnaGV4Jyk7XG4gICAgICAgIH1cbiAgICAgICAgZGVidWcoJ0NvbXBpbGluZyB3aXRoOlxcblxcdCcgKyBhcmdzLmpvaW4oJ1xcblxcdCcpKTtcbiAgICAgICAgY29uc3QgZXhpdENvZGUgPSBydW5PbmVCdWlsZChhcmdzLCBpbnB1dHMpID8gMCA6IDE7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCh3b3JrZXJwYi5Xb3JrUmVzcG9uc2UuZW5jb2RlRGVsaW1pdGVkKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleGl0Q29kZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGNvbnNvbGVPdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pKS5maW5pc2goKSBhcyBCdWZmZXIpO1xuICAgICAgICAvLyBGb3JjZSBhIGdhcmJhZ2UgY29sbGVjdGlvbiBwYXNzLiAgVGhpcyBrZWVwcyBvdXIgbWVtb3J5IHVzYWdlXG4gICAgICAgIC8vIGNvbnNpc3RlbnQgYWNyb3NzIG11bHRpcGxlIGNvbXBpbGF0aW9ucywgYW5kIGFsbG93cyB0aGUgZmlsZVxuICAgICAgICAvLyBjYWNoZSB0byB1c2UgdGhlIGN1cnJlbnQgbWVtb3J5IHVzYWdlIGFzIGEgZ3VpZGVsaW5lIGZvciBleHBpcmluZ1xuICAgICAgICAvLyBkYXRhLiAgTm90ZTogdGhpcyBpcyBpbnRlbnRpb25hbGx5IG5vdCB3aXRoaW4gcnVuT25lQnVpbGQoKSwgYXNcbiAgICAgICAgLy8gd2Ugd2FudCB0byBnYyBvbmx5IGFmdGVyIGFsbCBpdHMgbG9jYWxzIGhhdmUgZ29uZSBvdXQgb2Ygc2NvcGUuXG4gICAgICAgIGdsb2JhbC5nYygpO1xuICAgICAgfVxuICAgICAgLy8gQWxsIG1lc3NhZ2VzIGhhdmUgYmVlbiBoYW5kbGVkLCBtYWtlIHN1cmUgdGhlIGludmFyaWFudCBob2xkcyBhbmRcbiAgICAgIC8vIEJ1ZmZlciBpcyBlbXB0eSBvbmNlIGFsbCBtZXNzYWdlcyBoYXZlIGJlZW4gcmVhZC5cbiAgICAgIGlmIChidWYubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2J1ZmZlciBub3QgZW1wdHkgYWZ0ZXIgcmVhZGluZyBhbGwgbWVzc2FnZXMnKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2coJ0NvbXBpbGF0aW9uIGZhaWxlZCcsIGUuc3RhY2spO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgd29ya2VycGIuV29ya1Jlc3BvbnNlXG4gICAgICAgICAgICAgIC5lbmNvZGVEZWxpbWl0ZWQoe2V4aXRDb2RlOiAxLCBvdXRwdXQ6IGNvbnNvbGVPdXRwdXR9KVxuICAgICAgICAgICAgICAuZmluaXNoKCkgYXMgQnVmZmVyKTtcbiAgICAgIC8vIENsZWFyIGJ1ZmZlciBzbyB0aGUgbmV4dCBidWlsZCB3b24ndCByZWFkIGFuIGluY29tcGxldGUgcmVxdWVzdC5cbiAgICAgIGJ1ZiA9IEJ1ZmZlci5hbGxvYygwKTtcbiAgICB9XG4gIH0pO1xufVxuIl19