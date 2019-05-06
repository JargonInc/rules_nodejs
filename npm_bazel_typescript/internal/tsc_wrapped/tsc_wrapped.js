(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "fs", "path", "typescript", "../tsetse/runner", "./cache", "./compiler_host", "./diagnostics", "./manifest", "./perf_trace", "./strict_deps", "./tsconfig", "./worker"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const fs = require("fs");
    const path = require("path");
    const ts = require("typescript");
    const runner_1 = require("../tsetse/runner");
    const cache_1 = require("./cache");
    const compiler_host_1 = require("./compiler_host");
    const bazelDiagnostics = require("./diagnostics");
    const manifest_1 = require("./manifest");
    const perfTrace = require("./perf_trace");
    const strict_deps_1 = require("./strict_deps");
    const tsconfig_1 = require("./tsconfig");
    const worker_1 = require("./worker");
    // Equivalent of running node with --expose-gc
    // but easier to write tooling since we don't need to inject that arg to
    // nodejs_binary
    if (typeof global.gc !== 'function') {
        require('v8').setFlagsFromString('--expose_gc');
        global.gc = require('vm').runInNewContext('gc');
    }
    /**
     * Top-level entry point for tsc_wrapped.
     */
    function main(args) {
        if (worker_1.runAsWorker(args)) {
            worker_1.log('Starting TypeScript compiler persistent worker...');
            worker_1.runWorkerLoop(runOneBuild);
            // Note: intentionally don't process.exit() here, because runWorkerLoop
            // is waiting for async callbacks from node.
        }
        else {
            worker_1.debug('Running a single build...');
            if (args.length === 0)
                throw new Error('Not enough arguments');
            if (!runOneBuild(args)) {
                return 1;
            }
        }
        return 0;
    }
    exports.main = main;
    /** The one ProgramAndFileCache instance used in this process. */
    const cache = new cache_1.ProgramAndFileCache(worker_1.debug);
    function isCompilationTarget(bazelOpts, sf) {
        if (bazelOpts.isJsTranspilation && bazelOpts.transpiledJsInputDirectory) {
            // transpiledJsInputDirectory is a relative logical path, so we cannot
            // compare it to the resolved, absolute path of sf here.
            // compilationTargetSrc is resolved, so use that for the comparison.
            return sf.fileName.startsWith(bazelOpts.compilationTargetSrc[0]);
        }
        return (bazelOpts.compilationTargetSrc.indexOf(sf.fileName) !== -1);
    }
    /**
     * Gather diagnostics from TypeScript's type-checker as well as other plugins we
     * install such as strict dependency checking.
     */
    function gatherDiagnostics(options, bazelOpts, program, disabledTsetseRules, angularPlugin) {
        // Install extra diagnostic plugins
        if (!bazelOpts.disableStrictDeps) {
            const ignoredFilesPrefixes = [];
            if (bazelOpts.nodeModulesPrefix) {
                // Under Bazel, we exempt external files fetched from npm from strict
                // deps. This is because we allow users to implicitly depend on all the
                // node_modules.
                // TODO(alexeagle): if users opt-in to fine-grained npm dependencies, we
                // should be able to enforce strict deps for them.
                ignoredFilesPrefixes.push(bazelOpts.nodeModulesPrefix);
                if (options.rootDir) {
                    ignoredFilesPrefixes.push(path.resolve(options.rootDir, 'node_modules'));
                }
            }
            program = strict_deps_1.PLUGIN.wrap(program, Object.assign({}, bazelOpts, { rootDir: options.rootDir, ignoredFilesPrefixes }));
        }
        if (!bazelOpts.isJsTranspilation) {
            let selectedTsetsePlugin = runner_1.PLUGIN;
            program = selectedTsetsePlugin.wrap(program, disabledTsetseRules);
        }
        if (angularPlugin) {
            program = angularPlugin.wrap(program);
        }
        const diagnostics = [];
        perfTrace.wrap('type checking', () => {
            // These checks mirror ts.getPreEmitDiagnostics, with the important
            // exception of avoiding b/30708240, which is that if you call
            // program.getDeclarationDiagnostics() it somehow corrupts the emit.
            perfTrace.wrap(`global diagnostics`, () => {
                diagnostics.push(...program.getOptionsDiagnostics());
                diagnostics.push(...program.getGlobalDiagnostics());
            });
            let sourceFilesToCheck;
            if (bazelOpts.typeCheckDependencies) {
                sourceFilesToCheck = program.getSourceFiles();
            }
            else {
                sourceFilesToCheck = program.getSourceFiles().filter(f => isCompilationTarget(bazelOpts, f));
            }
            for (const sf of sourceFilesToCheck) {
                perfTrace.wrap(`check ${sf.fileName}`, () => {
                    diagnostics.push(...program.getSyntacticDiagnostics(sf));
                    diagnostics.push(...program.getSemanticDiagnostics(sf));
                });
                perfTrace.snapshotMemoryUsage();
            }
        });
        return diagnostics;
    }
    exports.gatherDiagnostics = gatherDiagnostics;
    /**
     * expandSourcesFromDirectories finds any directories under filePath and expands
     * them to their .js or .ts contents.
     */
    function expandSourcesFromDirectories(fileList, filePath) {
        if (!fs.statSync(filePath).isDirectory()) {
            if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') ||
                filePath.endsWith('.js')) {
                fileList.push(filePath);
            }
            return;
        }
        const entries = fs.readdirSync(filePath);
        for (const entry of entries) {
            expandSourcesFromDirectories(fileList, path.join(filePath, entry));
        }
    }
    /**
     * Runs a single build, returning false on failure.  This is potentially called
     * multiple times (once per bazel request) when running as a bazel worker.
     * Any encountered errors are written to stderr.
     */
    function runOneBuild(args, inputs) {
        if (args.length !== 1) {
            console.error('Expected one argument: path to tsconfig.json');
            return false;
        }
        perfTrace.snapshotMemoryUsage();
        // Strip leading at-signs, used in build_defs.bzl to indicate a params file
        const tsconfigFile = args[0].replace(/^@+/, '');
        const [parsed, errors, { target }] = tsconfig_1.parseTsconfig(tsconfigFile);
        if (errors) {
            console.error(bazelDiagnostics.format(target, errors));
            return false;
        }
        if (!parsed) {
            throw new Error('Impossible state: if parseTsconfig returns no errors, then parsed should be non-null');
        }
        const { options, bazelOpts, files, disabledTsetseRules, angularCompilerOptions } = parsed;
        const sourceFiles = [];
        for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            expandSourcesFromDirectories(sourceFiles, filePath);
        }
        if (bazelOpts.maxCacheSizeMb !== undefined) {
            const maxCacheSizeBytes = bazelOpts.maxCacheSizeMb * (1 << 20);
            cache.setMaxCacheSize(maxCacheSizeBytes);
        }
        else {
            cache.resetMaxCacheSize();
        }
        let fileLoader;
        if (inputs) {
            fileLoader = new cache_1.CachedFileLoader(cache);
            // Resolve the inputs to absolute paths to match TypeScript internals
            const resolvedInputs = new Map();
            for (const key of Object.keys(inputs)) {
                resolvedInputs.set(tsconfig_1.resolveNormalizedPath(key), inputs[key]);
            }
            cache.updateCache(resolvedInputs);
        }
        else {
            fileLoader = new cache_1.UncachedFileLoader();
        }
        const perfTracePath = bazelOpts.perfTracePath;
        if (!perfTracePath) {
            return runFromOptions(fileLoader, options, bazelOpts, sourceFiles, disabledTsetseRules, angularCompilerOptions);
        }
        worker_1.log('Writing trace to', perfTracePath);
        const success = perfTrace.wrap('runOneBuild', () => runFromOptions(fileLoader, options, bazelOpts, sourceFiles, disabledTsetseRules, angularCompilerOptions));
        if (!success)
            return false;
        // Force a garbage collection pass.  This keeps our memory usage
        // consistent across multiple compilations, and allows the file
        // cache to use the current memory usage as a guideline for expiring
        // data.  Note: this is intentionally not within runFromOptions(), as
        // we want to gc only after all its locals have gone out of scope.
        global.gc();
        perfTrace.snapshotMemoryUsage();
        perfTrace.write(perfTracePath);
        return true;
    }
    // We only allow our own code to use the expected_diagnostics attribute
    const expectDiagnosticsWhitelist = [];
    function runFromOptions(fileLoader, options, bazelOpts, files, disabledTsetseRules, angularCompilerOptions) {
        perfTrace.snapshotMemoryUsage();
        cache.resetStats();
        cache.traceStats();
        const compilerHostDelegate = ts.createCompilerHost({ target: ts.ScriptTarget.ES5 });
        const moduleResolver = bazelOpts.isJsTranspilation ?
            makeJsModuleResolver(bazelOpts.workspaceName) :
            ts.resolveModuleName;
        const tsickleCompilerHost = new compiler_host_1.CompilerHost(files, options, bazelOpts, compilerHostDelegate, fileLoader, moduleResolver);
        let compilerHost = tsickleCompilerHost;
        let angularPlugin;
        if (bazelOpts.compileAngularTemplates) {
            try {
                const ngOptions = angularCompilerOptions || {};
                // Add the rootDir setting to the options passed to NgTscPlugin.
                // Required so that synthetic files added to the rootFiles in the program
                // can be given absolute paths, just as we do in tsconfig.ts, matching
                // the behavior in TypeScript's tsconfig parsing logic.
                ngOptions['rootDir'] = options.rootDir;
                // Dynamically load the Angular compiler installed as a peerDep
                const ngtsc = require('@angular/compiler-cli');
                angularPlugin = new ngtsc.NgTscPlugin(ngOptions);
            }
            catch (e) {
                console.error(e);
                throw new Error('when using `ts_library(compile_angular_templates=True)`, ' +
                    'you must install @angular/compiler-cli');
            }
            // Wrap host only needed until after Ivy cleanup
            // TODO(alexeagle): remove after ngsummary and ngfactory files eliminated
            compilerHost = angularPlugin.wrapHost(files, compilerHost);
        }
        const oldProgram = cache.getProgram(bazelOpts.target);
        const program = perfTrace.wrap('createProgram', () => ts.createProgram(compilerHost.inputFiles, options, compilerHost, oldProgram));
        cache.putProgram(bazelOpts.target, program);
        if (!bazelOpts.isJsTranspilation) {
            // If there are any TypeScript type errors abort now, so the error
            // messages refer to the original source.  After any subsequent passes
            // (decorator downleveling or tsickle) we do not type check.
            let diagnostics = gatherDiagnostics(options, bazelOpts, program, disabledTsetseRules, angularPlugin);
            if (!expectDiagnosticsWhitelist.length ||
                expectDiagnosticsWhitelist.some(p => bazelOpts.target.startsWith(p))) {
                diagnostics = bazelDiagnostics.filterExpected(bazelOpts, diagnostics, bazelDiagnostics.uglyFormat);
            }
            else if (bazelOpts.expectedDiagnostics.length > 0) {
                console.error(`Only targets under ${expectDiagnosticsWhitelist.join(', ')} can use ` +
                    'expected_diagnostics, but got', bazelOpts.target);
            }
            if (diagnostics.length > 0) {
                console.error(bazelDiagnostics.format(bazelOpts.target, diagnostics));
                worker_1.debug('compilation failed at', new Error().stack);
                return false;
            }
        }
        const compilationTargets = program.getSourceFiles().filter(fileName => isCompilationTarget(bazelOpts, fileName));
        let diagnostics = [];
        let useTsickleEmit = bazelOpts.tsickle;
        let transforms = {
            before: [],
            after: [],
            afterDeclarations: [],
        };
        if (angularPlugin) {
            transforms = angularPlugin.createTransformers(compilerHost);
        }
        if (useTsickleEmit) {
            diagnostics = emitWithTsickle(program, tsickleCompilerHost, compilationTargets, options, bazelOpts, transforms);
        }
        else {
            diagnostics = emitWithTypescript(program, compilationTargets, transforms);
        }
        if (diagnostics.length > 0) {
            console.error(bazelDiagnostics.format(bazelOpts.target, diagnostics));
            worker_1.debug('compilation failed at', new Error().stack);
            return false;
        }
        cache.printStats();
        return true;
    }
    function emitWithTypescript(program, compilationTargets, transforms) {
        const diagnostics = [];
        for (const sf of compilationTargets) {
            const result = program.emit(sf, /*writeFile*/ undefined, 
            /*cancellationToken*/ undefined, /*emitOnlyDtsFiles*/ undefined, transforms);
            diagnostics.push(...result.diagnostics);
        }
        return diagnostics;
    }
    /**
     * Runs the emit pipeline with Tsickle transformations - goog.module rewriting
     * and Closure types emitted included.
     * Exported to be used by the internal global refactoring tools.
     * TODO(radokirov): investigate using runWithOptions and making this private
     * again, if we can make compilerHosts match.
     */
    function emitWithTsickle(program, compilerHost, compilationTargets, options, bazelOpts, transforms) {
        const emitResults = [];
        const diagnostics = [];
        // The 'tsickle' import above is only used in type positions, so it won't
        // result in a runtime dependency on tsickle.
        // If the user requests the tsickle emit, then we dynamically require it
        // here for use at runtime.
        let optTsickle;
        try {
            // tslint:disable-next-line:no-require-imports
            optTsickle = require('tsickle');
        }
        catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') {
                throw e;
            }
            throw new Error('When setting bazelOpts { tsickle: true }, ' +
                'you must also add a devDependency on the tsickle npm package');
        }
        perfTrace.wrap('emit', () => {
            for (const sf of compilationTargets) {
                perfTrace.wrap(`emit ${sf.fileName}`, () => {
                    emitResults.push(optTsickle.emitWithTsickle(program, compilerHost, compilerHost, options, sf, 
                    /*writeFile*/ undefined, 
                    /*cancellationToken*/ undefined, /*emitOnlyDtsFiles*/ undefined, {
                        beforeTs: transforms.before,
                        afterTs: transforms.after,
                        afterDeclarations: transforms.afterDeclarations,
                    }));
                });
            }
        });
        const emitResult = optTsickle.mergeEmitResults(emitResults);
        diagnostics.push(...emitResult.diagnostics);
        // If tsickle reported diagnostics, don't produce externs or manifest outputs.
        if (diagnostics.length > 0) {
            return diagnostics;
        }
        let externs = '/** @externs */\n' +
            '// generating externs was disabled using generate_externs=False\n';
        if (bazelOpts.tsickleGenerateExterns) {
            externs =
                optTsickle.getGeneratedExterns(emitResult.externs, options.rootDir);
        }
        if (bazelOpts.tsickleExternsPath) {
            // Note: when tsickleExternsPath is provided, we always write a file as a
            // marker that compilation succeeded, even if it's empty (just containing an
            // @externs).
            fs.writeFileSync(bazelOpts.tsickleExternsPath, externs);
            // When generating externs, generate an externs file for each of the input
            // .d.ts files.
            if (bazelOpts.tsickleGenerateExterns &&
                compilerHost.provideExternalModuleDtsNamespace) {
                for (const extern of compilationTargets) {
                    if (!extern.isDeclarationFile)
                        continue;
                    const outputBaseDir = options.outDir;
                    const relativeOutputPath = compilerHost.relativeOutputPath(extern.fileName);
                    mkdirp(outputBaseDir, path.dirname(relativeOutputPath));
                    const outputPath = path.join(outputBaseDir, relativeOutputPath);
                    const moduleName = compilerHost.pathToModuleName('', extern.fileName);
                    fs.writeFileSync(outputPath, `goog.module('${moduleName}');\n` +
                        `// Export an empty object of unknown type to allow imports.\n` +
                        `// TODO: use typeof once available\n` +
                        `exports = /** @type {?} */ ({});\n`);
                }
            }
        }
        if (bazelOpts.manifest) {
            perfTrace.wrap('manifest', () => {
                const manifest = manifest_1.constructManifest(emitResult.modulesManifest, compilerHost);
                fs.writeFileSync(bazelOpts.manifest, manifest);
            });
        }
        return diagnostics;
    }
    exports.emitWithTsickle = emitWithTsickle;
    /**
     * Creates directories subdir (a slash separated relative path) starting from
     * base.
     */
    function mkdirp(base, subdir) {
        const steps = subdir.split(path.sep);
        let current = base;
        for (let i = 0; i < steps.length; i++) {
            current = path.join(current, steps[i]);
            if (!fs.existsSync(current))
                fs.mkdirSync(current);
        }
    }
    /**
     * Resolve module filenames for JS modules.
     *
     * JS module resolution needs to be different because when transpiling JS we
     * do not pass in any dependencies, so the TS module resolver will not resolve
     * any files.
     *
     * Fortunately, JS module resolution is very simple. The imported module name
     * must either a relative path, or the workspace root (i.e. 'google3'),
     * so we can perform module resolution entirely based on file names, without
     * looking at the filesystem.
     */
    function makeJsModuleResolver(workspaceName) {
        // The literal '/' here is cross-platform safe because it's matching on
        // import specifiers, not file names.
        const workspaceModuleSpecifierPrefix = `${workspaceName}/`;
        const workspaceDir = `${path.sep}${workspaceName}${path.sep}`;
        function jsModuleResolver(moduleName, containingFile, compilerOptions, host) {
            let resolvedFileName;
            if (containingFile === '') {
                // In tsickle we resolve the filename against '' to get the goog module
                // name of a sourcefile.
                resolvedFileName = moduleName;
            }
            else if (moduleName.startsWith(workspaceModuleSpecifierPrefix)) {
                // Given a workspace name of 'foo', we want to resolve import specifiers
                // like: 'foo/project/file.js' to the absolute filesystem path of
                // project/file.js within the workspace.
                const workspaceDirLocation = containingFile.indexOf(workspaceDir);
                if (workspaceDirLocation < 0) {
                    return { resolvedModule: undefined };
                }
                const absolutePathToWorkspaceDir = containingFile.slice(0, workspaceDirLocation);
                resolvedFileName = path.join(absolutePathToWorkspaceDir, moduleName);
            }
            else {
                if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) {
                    throw new Error(`Unsupported module import specifier: ${JSON.stringify(moduleName)}.\n` +
                        `JS module imports must either be relative paths ` +
                        `(beginning with '.' or '..'), ` +
                        `or they must begin with '${workspaceName}/'.`);
                }
                resolvedFileName = path.join(path.dirname(containingFile), moduleName);
            }
            return {
                resolvedModule: {
                    resolvedFileName,
                    extension: ts.Extension.Js,
                    // These two fields are cargo culted from what ts.resolveModuleName
                    // seems to return.
                    packageId: undefined,
                    isExternalLibraryImport: false,
                }
            };
        }
        return jsModuleResolver;
    }
    if (require.main === module) {
        // Do not call process.exit(), as that terminates the binary before
        // completing pending operations, such as writing to stdout or emitting the
        // v8 performance log. Rather, set the exit code and fall off the main
        // thread, which will cause node to terminate cleanly.
        process.exitCode = main(process.argv.slice(2));
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHNjX3dyYXBwZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzY193cmFwcGVkL3RzY193cmFwcGVkLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0lBQUEseUJBQXlCO0lBQ3pCLDZCQUE2QjtJQUU3QixpQ0FBaUM7SUFFakMsNkNBQWtFO0lBRWxFLG1DQUE4RjtJQUM5RixtREFBNkM7SUFDN0Msa0RBQWtEO0lBQ2xELHlDQUE2QztJQUM3QywwQ0FBMEM7SUFFMUMsK0NBQXlEO0lBQ3pELHlDQUE4RTtJQUM5RSxxQ0FBZ0U7SUFFaEUsOENBQThDO0lBQzlDLHdFQUF3RTtJQUN4RSxnQkFBZ0I7SUFDaEIsSUFBSSxPQUFPLE1BQU0sQ0FBQyxFQUFFLEtBQUssVUFBVSxFQUFFO1FBQ25DLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxrQkFBa0IsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNoRCxNQUFNLENBQUMsRUFBRSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7S0FDakQ7SUFFRDs7T0FFRztJQUNILFNBQWdCLElBQUksQ0FBQyxJQUFjO1FBQ2pDLElBQUksb0JBQVcsQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNyQixZQUFHLENBQUMsbURBQW1ELENBQUMsQ0FBQztZQUN6RCxzQkFBYSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQzNCLHVFQUF1RTtZQUN2RSw0Q0FBNEM7U0FDN0M7YUFBTTtZQUNMLGNBQUssQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO1lBQ25DLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDO2dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUMvRCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxF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QUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxFQUFFO29CQUNqRSxNQUFNLElBQUksS0FBSyxDQUNYLHdDQUNJLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLEtBQUs7d0JBQ25DLGtEQUFrRDt3QkFDbEQsZ0NBQWdDO3dCQUNoQyw0QkFBNEIsYUFBYSxLQUFLLENBQUMsQ0FBQztpQkFDckQ7Z0JBQ0QsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxFQUFFLFVBQVUsQ0FBQyxDQUFDO2FBQ3hFO1lBQ0QsT0FBTztnQkFDTCxjQUFjLEVBQUU7b0JBQ2QsZ0JBQWdCO29CQUNoQixTQUFTLEVBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxFQUFFO29CQUMxQixtRUFBbUU7b0JBQ25FLG1CQUFtQjtvQkFDbkIsU0FBUyxFQUFFLFNBQVM7b0JBQ3BCLHVCQUF1QixFQUFFLEtBQUs7aUJBQy9CO2FBQ0YsQ0FBQztRQUNKLENBQUM7UUFFRCxPQUFPLGdCQUFnQixDQUFDO0lBQzFCLENBQUM7SUFHRCxJQUFJLE9BQU8sQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFO1FBQzNCLG1FQUFtRTtRQUNuRSwyRUFBMkU7UUFDM0Usc0VBQXNFO1FBQ3RFLHNEQUFzRDtRQUN0RCxPQUFPLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0tBQ2hEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIHRzaWNrbGUgZnJvbSAndHNpY2tsZSc7XG5pbXBvcnQgKiBhcyB0cyBmcm9tICd0eXBlc2NyaXB0JztcblxuaW1wb3J0IHtQTFVHSU4gYXMgYmF6ZWxDb25mb3JtYW5jZVBsdWdpbn0gZnJvbSAnLi4vdHNldHNlL3J1bm5lcic7XG5cbmltcG9ydCB7Q2FjaGVkRmlsZUxvYWRlciwgRmlsZUxvYWRlciwgUHJvZ3JhbUFuZEZpbGVDYWNoZSwgVW5jYWNoZWRGaWxlTG9hZGVyfSBmcm9tICcuL2NhY2hlJztcbmltcG9ydCB7Q29tcGlsZXJIb3N0fSBmcm9tICcuL2NvbXBpbGVyX2hvc3QnO1xuaW1wb3J0ICogYXMgYmF6ZWxEaWFnbm9zdGljcyBmcm9tICcuL2RpYWdub3N0aWNzJztcbmltcG9ydCB7Y29uc3RydWN0TWFuaWZlc3R9IGZyb20gJy4vbWFuaWZlc3QnO1xuaW1wb3J0ICogYXMgcGVyZlRyYWNlIGZyb20gJy4vcGVyZl90cmFjZSc7XG5pbXBvcnQge1BsdWdpbkNvbXBpbGVySG9zdCwgVHNjUGx1Z2lufSBmcm9tICcuL3BsdWdpbl9hcGknO1xuaW1wb3J0IHtQTFVHSU4gYXMgc3RyaWN0RGVwc1BsdWdpbn0gZnJvbSAnLi9zdHJpY3RfZGVwcyc7XG5pbXBvcnQge0JhemVsT3B0aW9ucywgcGFyc2VUc2NvbmZpZywgcmVzb2x2ZU5vcm1hbGl6ZWRQYXRofSBmcm9tICcuL3RzY29uZmlnJztcbmltcG9ydCB7ZGVidWcsIGxvZywgcnVuQXNXb3JrZXIsIHJ1bldvcmtlckxvb3B9IGZyb20gJy4vd29ya2VyJztcblxuLy8gRXF1aXZhbGVudCBvZiBydW5uaW5nIG5vZGUgd2l0aCAtLWV4cG9zZS1nY1xuLy8gYnV0IGVhc2llciB0byB3cml0ZSB0b29saW5nIHNpbmNlIHdlIGRvbid0IG5lZWQgdG8gaW5qZWN0IHRoYXQgYXJnIHRvXG4vLyBub2RlanNfYmluYXJ5XG5pZiAodHlwZW9mIGdsb2JhbC5nYyAhPT0gJ2Z1bmN0aW9uJykge1xuICByZXF1aXJlKCd2OCcpLnNldEZsYWdzRnJvbVN0cmluZygnLS1leHBvc2VfZ2MnKTtcbiAgZ2xvYmFsLmdjID0gcmVxdWlyZSgndm0nKS5ydW5Jbk5ld0NvbnRleHQoJ2djJyk7XG59XG5cbi8qKlxuICogVG9wLWxldmVsIGVudHJ5IHBvaW50IGZvciB0c2Nfd3JhcHBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1haW4oYXJnczogc3RyaW5nW10pIHtcbiAgaWYgKHJ1bkFzV29ya2VyKGFyZ3MpKSB7XG4gICAgbG9nKCdTdGFydGluZyBUeXBlU2NyaXB0IGNvbXBpbGVyIHBlcnNpc3RlbnQgd29ya2VyLi4uJyk7XG4gICAgcnVuV29ya2VyTG9vcChydW5PbmVCdWlsZCk7XG4gICAgLy8gTm90ZTogaW50ZW50aW9uYWxseSBkb24ndCBwcm9jZXNzLmV4aXQoKSBoZXJlLCBiZWNhdXNlIHJ1bldvcmtlckxvb3BcbiAgICAvLyBpcyB3YWl0aW5nIGZvciBhc3luYyBjYWxsYmFja3MgZnJvbSBub2RlLlxuICB9IGVsc2Uge1xuICAgIGRlYnVnKCdSdW5uaW5nIGEgc2luZ2xlIGJ1aWxkLi4uJyk7XG4gICAgaWYgKGFyZ3MubGVuZ3RoID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoJ05vdCBlbm91Z2ggYXJndW1lbnRzJyk7XG4gICAgaWYgKCFydW5PbmVCdWlsZChhcmdzKSkge1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICB9XG4gIHJldHVybiAwO1xufVxuXG4vKiogVGhlIG9uZSBQcm9ncmFtQW5kRmlsZUNhY2hlIGluc3RhbmNlIHVzZWQgaW4gdGhpcyBwcm9jZXNzLiAqL1xuY29uc3QgY2FjaGUgPSBuZXcgUHJvZ3JhbUFuZEZpbGVDYWNoZShkZWJ1Zyk7XG5cbmZ1bmN0aW9uIGlzQ29tcGlsYXRpb25UYXJnZXQoXG4gICAgYmF6ZWxPcHRzOiBCYXplbE9wdGlvbnMsIHNmOiB0cy5Tb3VyY2VGaWxlKTogYm9vbGVhbiB7XG4gIGlmIChiYXplbE9wdHMuaXNKc1RyYW5zcGlsYXRpb24gJiYgYmF6ZWxPcHRzLnRyYW5zcGlsZWRKc0lucHV0RGlyZWN0b3J5KSB7XG4gICAgLy8gdHJhbnNwaWxlZEpzSW5wdXREaXJlY3RvcnkgaXMgYSByZWxhdGl2ZSBsb2dpY2FsIHBhdGgsIHNvIHdlIGNhbm5vdFxuICAgIC8vIGNvbXBhcmUgaXQgdG8gdGhlIHJlc29sdmVkLCBhYnNvbHV0ZSBwYXRoIG9mIHNmIGhlcmUuXG4gICAgLy8gY29tcGlsYXRpb25UYXJnZXRTcmMgaXMgcmVzb2x2ZWQsIHNvIHVzZSB0aGF0IGZvciB0aGUgY29tcGFyaXNvbi5cbiAgICByZXR1cm4gc2YuZmlsZU5hbWUuc3RhcnRzV2l0aChiYXplbE9wdHMuY29tcGlsYXRpb25UYXJnZXRTcmNbMF0pO1xuICB9XG4gIHJldHVybiAoYmF6ZWxPcHRzLmNvbXBpbGF0aW9uVGFyZ2V0U3JjLmluZGV4T2Yoc2YuZmlsZU5hbWUpICE9PSAtMSk7XG59XG5cbi8qKlxuICogR2F0aGVyIGRpYWdub3N0aWNzIGZyb20gVHlwZVNjcmlwdCdzIHR5cGUtY2hlY2tlciBhcyB3ZWxsIGFzIG90aGVyIHBsdWdpbnMgd2VcbiAqIGluc3RhbGwgc3VjaCBhcyBzdHJpY3QgZGVwZW5kZW5jeSBjaGVja2luZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdhdGhlckRpYWdub3N0aWNzKFxuICAgIG9wdGlvbnM6IHRzLkNvbXBpbGVyT3B0aW9ucywgYmF6ZWxPcHRzOiBCYXplbE9wdGlvbnMsIHByb2dyYW06IHRzLlByb2dyYW0sXG4gICAgZGlzYWJsZWRUc2V0c2VSdWxlczogc3RyaW5nW10sIGFuZ3VsYXJQbHVnaW4/OiBUc2NQbHVnaW4pOiB0cy5EaWFnbm9zdGljW10ge1xuICAvLyBJbnN0YWxsIGV4dHJhIGRpYWdub3N0aWMgcGx1Z2luc1xuICBpZiAoIWJhemVsT3B0cy5kaXNhYmxlU3RyaWN0RGVwcykge1xuICAgIGNvbnN0IGlnbm9yZWRGaWxlc1ByZWZpeGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChiYXplbE9wdHMubm9kZU1vZHVsZXNQcmVmaXgpIHtcbiAgICAgIC8vIFVuZGVyIEJhemVsLCB3ZSBleGVtcHQgZXh0ZXJuYWwgZmlsZXMgZmV0Y2hlZCBmcm9tIG5wbSBmcm9tIHN0cmljdFxuICAgICAgLy8gZGVwcy4gVGhpcyBpcyBiZWNhdXNlIHdlIGFsbG93IHVzZXJzIHRvIGltcGxpY2l0bHkgZGVwZW5kIG9uIGFsbCB0aGVcbiAgICAgIC8vIG5vZGVfbW9kdWxlcy5cbiAgICAgIC8vIFRPRE8oYWxleGVhZ2xlKTogaWYgdXNlcnMgb3B0LWluIHRvIGZpbmUtZ3JhaW5lZCBucG0gZGVwZW5kZW5jaWVzLCB3ZVxuICAgICAgLy8gc2hvdWxkIGJlIGFibGUgdG8gZW5mb3JjZSBzdHJpY3QgZGVwcyBmb3IgdGhlbS5cbiAgICAgIGlnbm9yZWRGaWxlc1ByZWZpeGVzLnB1c2goYmF6ZWxPcHRzLm5vZGVNb2R1bGVzUHJlZml4KTtcbiAgICAgIGlmIChvcHRpb25zLnJvb3REaXIpIHtcbiAgICAgICAgaWdub3JlZEZpbGVzUHJlZml4ZXMucHVzaChcbiAgICAgICAgICAgIHBhdGgucmVzb2x2ZShvcHRpb25zLnJvb3REaXIhLCAnbm9kZV9tb2R1bGVzJykpO1xuICAgICAgfVxuICAgIH1cbiAgICBwcm9ncmFtID0gc3RyaWN0RGVwc1BsdWdpbi53cmFwKHByb2dyYW0sIHtcbiAgICAgIC4uLmJhemVsT3B0cyxcbiAgICAgIHJvb3REaXI6IG9wdGlvbnMucm9vdERpcixcbiAgICAgIGlnbm9yZWRGaWxlc1ByZWZpeGVzLFxuICAgIH0pO1xuICB9XG4gIGlmICghYmF6ZWxPcHRzLmlzSnNUcmFuc3BpbGF0aW9uKSB7XG4gICAgbGV0IHNlbGVjdGVkVHNldHNlUGx1Z2luID0gYmF6ZWxDb25mb3JtYW5jZVBsdWdpbjtcbiAgICBwcm9ncmFtID0gc2VsZWN0ZWRUc2V0c2VQbHVnaW4ud3JhcChwcm9ncmFtLCBkaXNhYmxlZFRzZXRzZVJ1bGVzKTtcbiAgfVxuICBpZiAoYW5ndWxhclBsdWdpbikge1xuICAgIHByb2dyYW0gPSBhbmd1bGFyUGx1Z2luLndyYXAocHJvZ3JhbSk7XG4gIH1cblxuICBjb25zdCBkaWFnbm9zdGljczogdHMuRGlhZ25vc3RpY1tdID0gW107XG4gIHBlcmZUcmFjZS53cmFwKCd0eXBlIGNoZWNraW5nJywgKCkgPT4ge1xuICAgIC8vIFRoZXNlIGNoZWNrcyBtaXJyb3IgdHMuZ2V0UHJlRW1pdERpYWdub3N0aWNzLCB3aXRoIHRoZSBpbXBvcnRhbnRcbiAgICAvLyBleGNlcHRpb24gb2YgYXZvaWRpbmcgYi8zMDcwODI0MCwgd2hpY2ggaXMgdGhhdCBpZiB5b3UgY2FsbFxuICAgIC8vIHByb2dyYW0uZ2V0RGVjbGFyYXRpb25EaWFnbm9zdGljcygpIGl0IHNvbWVob3cgY29ycnVwdHMgdGhlIGVtaXQuXG4gICAgcGVyZlRyYWNlLndyYXAoYGdsb2JhbCBkaWFnbm9zdGljc2AsICgpID0+IHtcbiAgICAgIGRpYWdub3N0aWNzLnB1c2goLi4ucHJvZ3JhbS5nZXRPcHRpb25zRGlhZ25vc3RpY3MoKSk7XG4gICAgICBkaWFnbm9zdGljcy5wdXNoKC4uLnByb2dyYW0uZ2V0R2xvYmFsRGlhZ25vc3RpY3MoKSk7XG4gICAgfSk7XG4gICAgbGV0IHNvdXJjZUZpbGVzVG9DaGVjazogUmVhZG9ubHlBcnJheTx0cy5Tb3VyY2VGaWxlPjtcbiAgICBpZiAoYmF6ZWxPcHRzLnR5cGVDaGVja0RlcGVuZGVuY2llcykge1xuICAgICAgc291cmNlRmlsZXNUb0NoZWNrID0gcHJvZ3JhbS5nZXRTb3VyY2VGaWxlcygpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzb3VyY2VGaWxlc1RvQ2hlY2sgPSBwcm9ncmFtLmdldFNvdXJjZUZpbGVzKCkuZmlsdGVyKFxuICAgICAgICAgIGYgPT4gaXNDb21waWxhdGlvblRhcmdldChiYXplbE9wdHMsIGYpKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzZiBvZiBzb3VyY2VGaWxlc1RvQ2hlY2spIHtcbiAgICAgIHBlcmZUcmFjZS53cmFwKGBjaGVjayAke3NmLmZpbGVOYW1lfWAsICgpID0+IHtcbiAgICAgICAgZGlhZ25vc3RpY3MucHVzaCguLi5wcm9ncmFtLmdldFN5bnRhY3RpY0RpYWdub3N0aWNzKHNmKSk7XG4gICAgICAgIGRpYWdub3N0aWNzLnB1c2goLi4ucHJvZ3JhbS5nZXRTZW1hbnRpY0RpYWdub3N0aWNzKHNmKSk7XG4gICAgICB9KTtcbiAgICAgIHBlcmZUcmFjZS5zbmFwc2hvdE1lbW9yeVVzYWdlKCk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gZGlhZ25vc3RpY3M7XG59XG5cbi8qKlxuICogZXhwYW5kU291cmNlc0Zyb21EaXJlY3RvcmllcyBmaW5kcyBhbnkgZGlyZWN0b3JpZXMgdW5kZXIgZmlsZVBhdGggYW5kIGV4cGFuZHNcbiAqIHRoZW0gdG8gdGhlaXIgLmpzIG9yIC50cyBjb250ZW50cy5cbiAqL1xuZnVuY3Rpb24gZXhwYW5kU291cmNlc0Zyb21EaXJlY3RvcmllcyhmaWxlTGlzdDogc3RyaW5nW10sIGZpbGVQYXRoOiBzdHJpbmcpIHtcbiAgaWYgKCFmcy5zdGF0U3luYyhmaWxlUGF0aCkuaXNEaXJlY3RvcnkoKSkge1xuICAgIGlmIChmaWxlUGF0aC5lbmRzV2l0aCgnLnRzJykgfHwgZmlsZVBhdGguZW5kc1dpdGgoJy50c3gnKSB8fFxuICAgICAgICBmaWxlUGF0aC5lbmRzV2l0aCgnLmpzJykpIHtcbiAgICAgIGZpbGVMaXN0LnB1c2goZmlsZVBhdGgpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgZW50cmllcyA9IGZzLnJlYWRkaXJTeW5jKGZpbGVQYXRoKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgZXhwYW5kU291cmNlc0Zyb21EaXJlY3RvcmllcyhmaWxlTGlzdCwgcGF0aC5qb2luKGZpbGVQYXRoLCBlbnRyeSkpO1xuICB9XG59XG5cbi8qKlxuICogUnVucyBhIHNpbmdsZSBidWlsZCwgcmV0dXJuaW5nIGZhbHNlIG9uIGZhaWx1cmUuICBUaGlzIGlzIHBvdGVudGlhbGx5IGNhbGxlZFxuICogbXVsdGlwbGUgdGltZXMgKG9uY2UgcGVyIGJhemVsIHJlcXVlc3QpIHdoZW4gcnVubmluZyBhcyBhIGJhemVsIHdvcmtlci5cbiAqIEFueSBlbmNvdW50ZXJlZCBlcnJvcnMgYXJlIHdyaXR0ZW4gdG8gc3RkZXJyLlxuICovXG5mdW5jdGlvbiBydW5PbmVCdWlsZChcbiAgICBhcmdzOiBzdHJpbmdbXSwgaW5wdXRzPzoge1twYXRoOiBzdHJpbmddOiBzdHJpbmd9KTogYm9vbGVhbiB7XG4gIGlmIChhcmdzLmxlbmd0aCAhPT0gMSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0V4cGVjdGVkIG9uZSBhcmd1bWVudDogcGF0aCB0byB0c2NvbmZpZy5qc29uJyk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcGVyZlRyYWNlLnNuYXBzaG90TWVtb3J5VXNhZ2UoKTtcblxuICAvLyBTdHJpcCBsZWFkaW5nIGF0LXNpZ25zLCB1c2VkIGluIGJ1aWxkX2RlZnMuYnpsIHRvIGluZGljYXRlIGEgcGFyYW1zIGZpbGVcbiAgY29uc3QgdHNjb25maWdGaWxlID0gYXJnc1swXS5yZXBsYWNlKC9eQCsvLCAnJyk7XG4gIGNvbnN0IFtwYXJzZWQsIGVycm9ycywge3RhcmdldH1dID0gcGFyc2VUc2NvbmZpZyh0c2NvbmZpZ0ZpbGUpO1xuICBpZiAoZXJyb3JzKSB7XG4gICAgY29uc29sZS5lcnJvcihiYXplbERpYWdub3N0aWNzLmZvcm1hdCh0YXJnZXQsIGVycm9ycykpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoIXBhcnNlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ0ltcG9zc2libGUgc3RhdGU6IGlmIHBhcnNlVHNjb25maWcgcmV0dXJucyBubyBlcnJvcnMsIHRoZW4gcGFyc2VkIHNob3VsZCBiZSBub24tbnVsbCcpO1xuICB9XG4gIGNvbnN0IHtcbiAgICBvcHRpb25zLFxuICAgIGJhemVsT3B0cyxcbiAgICBmaWxlcyxcbiAgICBkaXNhYmxlZFRzZXRzZVJ1bGVzLFxuICAgIGFuZ3VsYXJDb21waWxlck9wdGlvbnNcbiAgfSA9IHBhcnNlZDtcblxuICBjb25zdCBzb3VyY2VGaWxlczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWxlcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGZpbGVQYXRoID0gZmlsZXNbaV07XG4gICAgZXhwYW5kU291cmNlc0Zyb21EaXJlY3Rvcmllcyhzb3VyY2VGaWxlcywgZmlsZVBhdGgpO1xuICB9XG5cbiAgaWYgKGJhemVsT3B0cy5tYXhDYWNoZVNpemVNYiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgbWF4Q2FjaGVTaXplQnl0ZXMgPSBiYXplbE9wdHMubWF4Q2FjaGVTaXplTWIgKiAoMSA8PCAyMCk7XG4gICAgY2FjaGUuc2V0TWF4Q2FjaGVTaXplKG1heENhY2hlU2l6ZUJ5dGVzKTtcbiAgfSBlbHNlIHtcbiAgICBjYWNoZS5yZXNldE1heENhY2hlU2l6ZSgpO1xuICB9XG5cbiAgbGV0IGZpbGVMb2FkZXI6IEZpbGVMb2FkZXI7XG4gIGlmIChpbnB1dHMpIHtcbiAgICBmaWxlTG9hZGVyID0gbmV3IENhY2hlZEZpbGVMb2FkZXIoY2FjaGUpO1xuICAgIC8vIFJlc29sdmUgdGhlIGlucHV0cyB0byBhYnNvbHV0ZSBwYXRocyB0byBtYXRjaCBUeXBlU2NyaXB0IGludGVybmFsc1xuICAgIGNvbnN0IHJlc29sdmVkSW5wdXRzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhpbnB1dHMpKSB7XG4gICAgICByZXNvbHZlZElucHV0cy5zZXQocmVzb2x2ZU5vcm1hbGl6ZWRQYXRoKGtleSksIGlucHV0c1trZXldKTtcbiAgICB9XG4gICAgY2FjaGUudXBkYXRlQ2FjaGUocmVzb2x2ZWRJbnB1dHMpO1xuICB9IGVsc2Uge1xuICAgIGZpbGVMb2FkZXIgPSBuZXcgVW5jYWNoZWRGaWxlTG9hZGVyKCk7XG4gIH1cblxuICBjb25zdCBwZXJmVHJhY2VQYXRoID0gYmF6ZWxPcHRzLnBlcmZUcmFjZVBhdGg7XG4gIGlmICghcGVyZlRyYWNlUGF0aCkge1xuICAgIHJldHVybiBydW5Gcm9tT3B0aW9ucyhcbiAgICAgICAgZmlsZUxvYWRlciwgb3B0aW9ucywgYmF6ZWxPcHRzLCBzb3VyY2VGaWxlcywgZGlzYWJsZWRUc2V0c2VSdWxlcyxcbiAgICAgICAgYW5ndWxhckNvbXBpbGVyT3B0aW9ucyk7XG4gIH1cblxuICBsb2coJ1dyaXRpbmcgdHJhY2UgdG8nLCBwZXJmVHJhY2VQYXRoKTtcbiAgY29uc3Qgc3VjY2VzcyA9IHBlcmZUcmFjZS53cmFwKFxuICAgICAgJ3J1bk9uZUJ1aWxkJyxcbiAgICAgICgpID0+IHJ1bkZyb21PcHRpb25zKFxuICAgICAgICAgIGZpbGVMb2FkZXIsIG9wdGlvbnMsIGJhemVsT3B0cywgc291cmNlRmlsZXMsIGRpc2FibGVkVHNldHNlUnVsZXMsXG4gICAgICAgICAgYW5ndWxhckNvbXBpbGVyT3B0aW9ucykpO1xuICBpZiAoIXN1Y2Nlc3MpIHJldHVybiBmYWxzZTtcbiAgLy8gRm9yY2UgYSBnYXJiYWdlIGNvbGxlY3Rpb24gcGFzcy4gIFRoaXMga2VlcHMgb3VyIG1lbW9yeSB1c2FnZVxuICAvLyBjb25zaXN0ZW50IGFjcm9zcyBtdWx0aXBsZSBjb21waWxhdGlvbnMsIGFuZCBhbGxvd3MgdGhlIGZpbGVcbiAgLy8gY2FjaGUgdG8gdXNlIHRoZSBjdXJyZW50IG1lbW9yeSB1c2FnZSBhcyBhIGd1aWRlbGluZSBmb3IgZXhwaXJpbmdcbiAgLy8gZGF0YS4gIE5vdGU6IHRoaXMgaXMgaW50ZW50aW9uYWxseSBub3Qgd2l0aGluIHJ1bkZyb21PcHRpb25zKCksIGFzXG4gIC8vIHdlIHdhbnQgdG8gZ2Mgb25seSBhZnRlciBhbGwgaXRzIGxvY2FscyBoYXZlIGdvbmUgb3V0IG9mIHNjb3BlLlxuICBnbG9iYWwuZ2MoKTtcblxuICBwZXJmVHJhY2Uuc25hcHNob3RNZW1vcnlVc2FnZSgpO1xuICBwZXJmVHJhY2Uud3JpdGUocGVyZlRyYWNlUGF0aCk7XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFdlIG9ubHkgYWxsb3cgb3VyIG93biBjb2RlIHRvIHVzZSB0aGUgZXhwZWN0ZWRfZGlhZ25vc3RpY3MgYXR0cmlidXRlXG5jb25zdCBleHBlY3REaWFnbm9zdGljc1doaXRlbGlzdDogc3RyaW5nW10gPSBbXG5dO1xuXG5mdW5jdGlvbiBydW5Gcm9tT3B0aW9ucyhcbiAgICBmaWxlTG9hZGVyOiBGaWxlTG9hZGVyLCBvcHRpb25zOiB0cy5Db21waWxlck9wdGlvbnMsXG4gICAgYmF6ZWxPcHRzOiBCYXplbE9wdGlvbnMsIGZpbGVzOiBzdHJpbmdbXSwgZGlzYWJsZWRUc2V0c2VSdWxlczogc3RyaW5nW10sXG4gICAgYW5ndWxhckNvbXBpbGVyT3B0aW9ucz86IHtba2V5OiBzdHJpbmddOiB1bmtub3dufSk6IGJvb2xlYW4ge1xuICBwZXJmVHJhY2Uuc25hcHNob3RNZW1vcnlVc2FnZSgpO1xuICBjYWNoZS5yZXNldFN0YXRzKCk7XG4gIGNhY2hlLnRyYWNlU3RhdHMoKTtcblxuICBjb25zdCBjb21waWxlckhvc3REZWxlZ2F0ZSA9XG4gICAgICB0cy5jcmVhdGVDb21waWxlckhvc3Qoe3RhcmdldDogdHMuU2NyaXB0VGFyZ2V0LkVTNX0pO1xuXG4gIGNvbnN0IG1vZHVsZVJlc29sdmVyID0gYmF6ZWxPcHRzLmlzSnNUcmFuc3BpbGF0aW9uID9cbiAgICAgIG1ha2VKc01vZHVsZVJlc29sdmVyKGJhemVsT3B0cy53b3Jrc3BhY2VOYW1lKSA6XG4gICAgICB0cy5yZXNvbHZlTW9kdWxlTmFtZTtcbiAgY29uc3QgdHNpY2tsZUNvbXBpbGVySG9zdCA9IG5ldyBDb21waWxlckhvc3QoXG4gICAgICBmaWxlcywgb3B0aW9ucywgYmF6ZWxPcHRzLCBjb21waWxlckhvc3REZWxlZ2F0ZSwgZmlsZUxvYWRlcixcbiAgICAgIG1vZHVsZVJlc29sdmVyKTtcbiAgbGV0IGNvbXBpbGVySG9zdDogUGx1Z2luQ29tcGlsZXJIb3N0ID0gdHNpY2tsZUNvbXBpbGVySG9zdDtcblxuICBsZXQgYW5ndWxhclBsdWdpbjogVHNjUGx1Z2lufHVuZGVmaW5lZDtcbiAgaWYgKGJhemVsT3B0cy5jb21waWxlQW5ndWxhclRlbXBsYXRlcykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBuZ09wdGlvbnMgPSBhbmd1bGFyQ29tcGlsZXJPcHRpb25zIHx8IHt9O1xuICAgICAgLy8gQWRkIHRoZSByb290RGlyIHNldHRpbmcgdG8gdGhlIG9wdGlvbnMgcGFzc2VkIHRvIE5nVHNjUGx1Z2luLlxuICAgICAgLy8gUmVxdWlyZWQgc28gdGhhdCBzeW50aGV0aWMgZmlsZXMgYWRkZWQgdG8gdGhlIHJvb3RGaWxlcyBpbiB0aGUgcHJvZ3JhbVxuICAgICAgLy8gY2FuIGJlIGdpdmVuIGFic29sdXRlIHBhdGhzLCBqdXN0IGFzIHdlIGRvIGluIHRzY29uZmlnLnRzLCBtYXRjaGluZ1xuICAgICAgLy8gdGhlIGJlaGF2aW9yIGluIFR5cGVTY3JpcHQncyB0c2NvbmZpZyBwYXJzaW5nIGxvZ2ljLlxuICAgICAgbmdPcHRpb25zWydyb290RGlyJ10gPSBvcHRpb25zLnJvb3REaXI7XG5cbiAgICAgIC8vIER5bmFtaWNhbGx5IGxvYWQgdGhlIEFuZ3VsYXIgY29tcGlsZXIgaW5zdGFsbGVkIGFzIGEgcGVlckRlcFxuICAgICAgY29uc3Qgbmd0c2MgPSByZXF1aXJlKCdAYW5ndWxhci9jb21waWxlci1jbGknKTtcbiAgICAgIGFuZ3VsYXJQbHVnaW4gPSBuZXcgbmd0c2MuTmdUc2NQbHVnaW4obmdPcHRpb25zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGUpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICd3aGVuIHVzaW5nIGB0c19saWJyYXJ5KGNvbXBpbGVfYW5ndWxhcl90ZW1wbGF0ZXM9VHJ1ZSlgLCAnICtcbiAgICAgICAgICAneW91IG11c3QgaW5zdGFsbCBAYW5ndWxhci9jb21waWxlci1jbGknKTtcbiAgICB9XG5cbiAgICAvLyBXcmFwIGhvc3Qgb25seSBuZWVkZWQgdW50aWwgYWZ0ZXIgSXZ5IGNsZWFudXBcbiAgICAvLyBUT0RPKGFsZXhlYWdsZSk6IHJlbW92ZSBhZnRlciBuZ3N1bW1hcnkgYW5kIG5nZmFjdG9yeSBmaWxlcyBlbGltaW5hdGVkXG4gICAgY29tcGlsZXJIb3N0ID0gYW5ndWxhclBsdWdpbiEud3JhcEhvc3QhKGZpbGVzLCBjb21waWxlckhvc3QpO1xuICB9XG5cblxuICBjb25zdCBvbGRQcm9ncmFtID0gY2FjaGUuZ2V0UHJvZ3JhbShiYXplbE9wdHMudGFyZ2V0KTtcbiAgY29uc3QgcHJvZ3JhbSA9IHBlcmZUcmFjZS53cmFwKFxuICAgICAgJ2NyZWF0ZVByb2dyYW0nLFxuICAgICAgKCkgPT4gdHMuY3JlYXRlUHJvZ3JhbShcbiAgICAgICAgICBjb21waWxlckhvc3QuaW5wdXRGaWxlcywgb3B0aW9ucywgY29tcGlsZXJIb3N0LCBvbGRQcm9ncmFtKSk7XG4gIGNhY2hlLnB1dFByb2dyYW0oYmF6ZWxPcHRzLnRhcmdldCwgcHJvZ3JhbSk7XG5cbiAgaWYgKCFiYXplbE9wdHMuaXNKc1RyYW5zcGlsYXRpb24pIHtcbiAgICAvLyBJZiB0aGVyZSBhcmUgYW55IFR5cGVTY3JpcHQgdHlwZSBlcnJvcnMgYWJvcnQgbm93LCBzbyB0aGUgZXJyb3JcbiAgICAvLyBtZXNzYWdlcyByZWZlciB0byB0aGUgb3JpZ2luYWwgc291cmNlLiAgQWZ0ZXIgYW55IHN1YnNlcXVlbnQgcGFzc2VzXG4gICAgLy8gKGRlY29yYXRvciBkb3dubGV2ZWxpbmcgb3IgdHNpY2tsZSkgd2UgZG8gbm90IHR5cGUgY2hlY2suXG4gICAgbGV0IGRpYWdub3N0aWNzID0gZ2F0aGVyRGlhZ25vc3RpY3MoXG4gICAgICAgIG9wdGlvbnMsIGJhemVsT3B0cywgcHJvZ3JhbSwgZGlzYWJsZWRUc2V0c2VSdWxlcywgYW5ndWxhclBsdWdpbik7XG4gICAgaWYgKCFleHBlY3REaWFnbm9zdGljc1doaXRlbGlzdC5sZW5ndGggfHxcbiAgICAgICAgZXhwZWN0RGlhZ25vc3RpY3NXaGl0ZWxpc3Quc29tZShwID0+IGJhemVsT3B0cy50YXJnZXQuc3RhcnRzV2l0aChwKSkpIHtcbiAgICAgIGRpYWdub3N0aWNzID0gYmF6ZWxEaWFnbm9zdGljcy5maWx0ZXJFeHBlY3RlZChcbiAgICAgICAgICBiYXplbE9wdHMsIGRpYWdub3N0aWNzLCBiYXplbERpYWdub3N0aWNzLnVnbHlGb3JtYXQpO1xuICAgIH0gZWxzZSBpZiAoYmF6ZWxPcHRzLmV4cGVjdGVkRGlhZ25vc3RpY3MubGVuZ3RoID4gMCkge1xuICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgT25seSB0YXJnZXRzIHVuZGVyICR7XG4gICAgICAgICAgICAgIGV4cGVjdERpYWdub3N0aWNzV2hpdGVsaXN0LmpvaW4oJywgJyl9IGNhbiB1c2UgYCArXG4gICAgICAgICAgICAgICdleHBlY3RlZF9kaWFnbm9zdGljcywgYnV0IGdvdCcsXG4gICAgICAgICAgYmF6ZWxPcHRzLnRhcmdldCk7XG4gICAgfVxuXG4gICAgaWYgKGRpYWdub3N0aWNzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYmF6ZWxEaWFnbm9zdGljcy5mb3JtYXQoYmF6ZWxPcHRzLnRhcmdldCwgZGlhZ25vc3RpY3MpKTtcbiAgICAgIGRlYnVnKCdjb21waWxhdGlvbiBmYWlsZWQgYXQnLCBuZXcgRXJyb3IoKS5zdGFjayEpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNvbXBpbGF0aW9uVGFyZ2V0cyA9IHByb2dyYW0uZ2V0U291cmNlRmlsZXMoKS5maWx0ZXIoXG4gICAgICBmaWxlTmFtZSA9PiBpc0NvbXBpbGF0aW9uVGFyZ2V0KGJhemVsT3B0cywgZmlsZU5hbWUpKTtcblxuICBsZXQgZGlhZ25vc3RpY3M6IHRzLkRpYWdub3N0aWNbXSA9IFtdO1xuICBsZXQgdXNlVHNpY2tsZUVtaXQgPSBiYXplbE9wdHMudHNpY2tsZTtcbiAgbGV0IHRyYW5zZm9ybXM6IHRzLkN1c3RvbVRyYW5zZm9ybWVycyA9IHtcbiAgICBiZWZvcmU6IFtdLFxuICAgIGFmdGVyOiBbXSxcbiAgICBhZnRlckRlY2xhcmF0aW9uczogW10sXG4gIH07XG5cbiAgaWYgKGFuZ3VsYXJQbHVnaW4pIHtcbiAgICB0cmFuc2Zvcm1zID0gYW5ndWxhclBsdWdpbi5jcmVhdGVUcmFuc2Zvcm1lcnMhKGNvbXBpbGVySG9zdCk7XG4gIH1cblxuICBpZiAodXNlVHNpY2tsZUVtaXQpIHtcbiAgICBkaWFnbm9zdGljcyA9IGVtaXRXaXRoVHNpY2tsZShcbiAgICAgICAgcHJvZ3JhbSwgdHNpY2tsZUNvbXBpbGVySG9zdCwgY29tcGlsYXRpb25UYXJnZXRzLCBvcHRpb25zLCBiYXplbE9wdHMsXG4gICAgICAgIHRyYW5zZm9ybXMpO1xuICB9IGVsc2Uge1xuICAgIGRpYWdub3N0aWNzID0gZW1pdFdpdGhUeXBlc2NyaXB0KHByb2dyYW0sIGNvbXBpbGF0aW9uVGFyZ2V0cywgdHJhbnNmb3Jtcyk7XG4gIH1cblxuICBpZiAoZGlhZ25vc3RpY3MubGVuZ3RoID4gMCkge1xuICAgIGNvbnNvbGUuZXJyb3IoYmF6ZWxEaWFnbm9zdGljcy5mb3JtYXQoYmF6ZWxPcHRzLnRhcmdldCwgZGlhZ25vc3RpY3MpKTtcbiAgICBkZWJ1ZygnY29tcGlsYXRpb24gZmFpbGVkIGF0JywgbmV3IEVycm9yKCkuc3RhY2shKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjYWNoZS5wcmludFN0YXRzKCk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBlbWl0V2l0aFR5cGVzY3JpcHQoXG4gICAgcHJvZ3JhbTogdHMuUHJvZ3JhbSwgY29tcGlsYXRpb25UYXJnZXRzOiB0cy5Tb3VyY2VGaWxlW10sXG4gICAgdHJhbnNmb3JtczogdHMuQ3VzdG9tVHJhbnNmb3JtZXJzKTogdHMuRGlhZ25vc3RpY1tdIHtcbiAgY29uc3QgZGlhZ25vc3RpY3M6IHRzLkRpYWdub3N0aWNbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNmIG9mIGNvbXBpbGF0aW9uVGFyZ2V0cykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHByb2dyYW0uZW1pdChcbiAgICAgICAgc2YsIC8qd3JpdGVGaWxlKi8gdW5kZWZpbmVkLFxuICAgICAgICAvKmNhbmNlbGxhdGlvblRva2VuKi8gdW5kZWZpbmVkLCAvKmVtaXRPbmx5RHRzRmlsZXMqLyB1bmRlZmluZWQsXG4gICAgICAgIHRyYW5zZm9ybXMpO1xuICAgIGRpYWdub3N0aWNzLnB1c2goLi4ucmVzdWx0LmRpYWdub3N0aWNzKTtcbiAgfVxuICByZXR1cm4gZGlhZ25vc3RpY3M7XG59XG5cbi8qKlxuICogUnVucyB0aGUgZW1pdCBwaXBlbGluZSB3aXRoIFRzaWNrbGUgdHJhbnNmb3JtYXRpb25zIC0gZ29vZy5tb2R1bGUgcmV3cml0aW5nXG4gKiBhbmQgQ2xvc3VyZSB0eXBlcyBlbWl0dGVkIGluY2x1ZGVkLlxuICogRXhwb3J0ZWQgdG8gYmUgdXNlZCBieSB0aGUgaW50ZXJuYWwgZ2xvYmFsIHJlZmFjdG9yaW5nIHRvb2xzLlxuICogVE9ETyhyYWRva2lyb3YpOiBpbnZlc3RpZ2F0ZSB1c2luZyBydW5XaXRoT3B0aW9ucyBhbmQgbWFraW5nIHRoaXMgcHJpdmF0ZVxuICogYWdhaW4sIGlmIHdlIGNhbiBtYWtlIGNvbXBpbGVySG9zdHMgbWF0Y2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbWl0V2l0aFRzaWNrbGUoXG4gICAgcHJvZ3JhbTogdHMuUHJvZ3JhbSwgY29tcGlsZXJIb3N0OiBDb21waWxlckhvc3QsXG4gICAgY29tcGlsYXRpb25UYXJnZXRzOiB0cy5Tb3VyY2VGaWxlW10sIG9wdGlvbnM6IHRzLkNvbXBpbGVyT3B0aW9ucyxcbiAgICBiYXplbE9wdHM6IEJhemVsT3B0aW9ucyxcbiAgICB0cmFuc2Zvcm1zOiB0cy5DdXN0b21UcmFuc2Zvcm1lcnMpOiB0cy5EaWFnbm9zdGljW10ge1xuICBjb25zdCBlbWl0UmVzdWx0czogdHNpY2tsZS5FbWl0UmVzdWx0W10gPSBbXTtcbiAgY29uc3QgZGlhZ25vc3RpY3M6IHRzLkRpYWdub3N0aWNbXSA9IFtdO1xuICAvLyBUaGUgJ3RzaWNrbGUnIGltcG9ydCBhYm92ZSBpcyBvbmx5IHVzZWQgaW4gdHlwZSBwb3NpdGlvbnMsIHNvIGl0IHdvbid0XG4gIC8vIHJlc3VsdCBpbiBhIHJ1bnRpbWUgZGVwZW5kZW5jeSBvbiB0c2lja2xlLlxuICAvLyBJZiB0aGUgdXNlciByZXF1ZXN0cyB0aGUgdHNpY2tsZSBlbWl0LCB0aGVuIHdlIGR5bmFtaWNhbGx5IHJlcXVpcmUgaXRcbiAgLy8gaGVyZSBmb3IgdXNlIGF0IHJ1bnRpbWUuXG4gIGxldCBvcHRUc2lja2xlOiB0eXBlb2YgdHNpY2tsZTtcbiAgdHJ5IHtcbiAgICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm8tcmVxdWlyZS1pbXBvcnRzXG4gICAgb3B0VHNpY2tsZSA9IHJlcXVpcmUoJ3RzaWNrbGUnKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlLmNvZGUgIT09ICdNT0RVTEVfTk9UX0ZPVU5EJykge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAnV2hlbiBzZXR0aW5nIGJhemVsT3B0cyB7IHRzaWNrbGU6IHRydWUgfSwgJyArXG4gICAgICAgICd5b3UgbXVzdCBhbHNvIGFkZCBhIGRldkRlcGVuZGVuY3kgb24gdGhlIHRzaWNrbGUgbnBtIHBhY2thZ2UnKTtcbiAgfVxuICBwZXJmVHJhY2Uud3JhcCgnZW1pdCcsICgpID0+IHtcbiAgICBmb3IgKGNvbnN0IHNmIG9mIGNvbXBpbGF0aW9uVGFyZ2V0cykge1xuICAgICAgcGVyZlRyYWNlLndyYXAoYGVtaXQgJHtzZi5maWxlTmFtZX1gLCAoKSA9PiB7XG4gICAgICAgIGVtaXRSZXN1bHRzLnB1c2gob3B0VHNpY2tsZS5lbWl0V2l0aFRzaWNrbGUoXG4gICAgICAgICAgICBwcm9ncmFtLCBjb21waWxlckhvc3QsIGNvbXBpbGVySG9zdCwgb3B0aW9ucywgc2YsXG4gICAgICAgICAgICAvKndyaXRlRmlsZSovIHVuZGVmaW5lZCxcbiAgICAgICAgICAgIC8qY2FuY2VsbGF0aW9uVG9rZW4qLyB1bmRlZmluZWQsIC8qZW1pdE9ubHlEdHNGaWxlcyovIHVuZGVmaW5lZCwge1xuICAgICAgICAgICAgICBiZWZvcmVUczogdHJhbnNmb3Jtcy5iZWZvcmUsXG4gICAgICAgICAgICAgIGFmdGVyVHM6IHRyYW5zZm9ybXMuYWZ0ZXIsXG4gICAgICAgICAgICAgIGFmdGVyRGVjbGFyYXRpb25zOiB0cmFuc2Zvcm1zLmFmdGVyRGVjbGFyYXRpb25zLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgfSk7XG4gICAgfVxuICB9KTtcbiAgY29uc3QgZW1pdFJlc3VsdCA9IG9wdFRzaWNrbGUubWVyZ2VFbWl0UmVzdWx0cyhlbWl0UmVzdWx0cyk7XG4gIGRpYWdub3N0aWNzLnB1c2goLi4uZW1pdFJlc3VsdC5kaWFnbm9zdGljcyk7XG5cbiAgLy8gSWYgdHNpY2tsZSByZXBvcnRlZCBkaWFnbm9zdGljcywgZG9uJ3QgcHJvZHVjZSBleHRlcm5zIG9yIG1hbmlmZXN0IG91dHB1dHMuXG4gIGlmIChkaWFnbm9zdGljcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIGRpYWdub3N0aWNzO1xuICB9XG5cbiAgbGV0IGV4dGVybnMgPSAnLyoqIEBleHRlcm5zICovXFxuJyArXG4gICAgICAnLy8gZ2VuZXJhdGluZyBleHRlcm5zIHdhcyBkaXNhYmxlZCB1c2luZyBnZW5lcmF0ZV9leHRlcm5zPUZhbHNlXFxuJztcbiAgaWYgKGJhemVsT3B0cy50c2lja2xlR2VuZXJhdGVFeHRlcm5zKSB7XG4gICAgZXh0ZXJucyA9XG4gICAgICAgIG9wdFRzaWNrbGUuZ2V0R2VuZXJhdGVkRXh0ZXJucyhlbWl0UmVzdWx0LmV4dGVybnMsIG9wdGlvbnMucm9vdERpciEpO1xuICB9XG5cbiAgaWYgKGJhemVsT3B0cy50c2lja2xlRXh0ZXJuc1BhdGgpIHtcbiAgICAvLyBOb3RlOiB3aGVuIHRzaWNrbGVFeHRlcm5zUGF0aCBpcyBwcm92aWRlZCwgd2UgYWx3YXlzIHdyaXRlIGEgZmlsZSBhcyBhXG4gICAgLy8gbWFya2VyIHRoYXQgY29tcGlsYXRpb24gc3VjY2VlZGVkLCBldmVuIGlmIGl0J3MgZW1wdHkgKGp1c3QgY29udGFpbmluZyBhblxuICAgIC8vIEBleHRlcm5zKS5cbiAgICBmcy53cml0ZUZpbGVTeW5jKGJhemVsT3B0cy50c2lja2xlRXh0ZXJuc1BhdGgsIGV4dGVybnMpO1xuXG4gICAgLy8gV2hlbiBnZW5lcmF0aW5nIGV4dGVybnMsIGdlbmVyYXRlIGFuIGV4dGVybnMgZmlsZSBmb3IgZWFjaCBvZiB0aGUgaW5wdXRcbiAgICAvLyAuZC50cyBmaWxlcy5cbiAgICBpZiAoYmF6ZWxPcHRzLnRzaWNrbGVHZW5lcmF0ZUV4dGVybnMgJiZcbiAgICAgICAgY29tcGlsZXJIb3N0LnByb3ZpZGVFeHRlcm5hbE1vZHVsZUR0c05hbWVzcGFjZSkge1xuICAgICAgZm9yIChjb25zdCBleHRlcm4gb2YgY29tcGlsYXRpb25UYXJnZXRzKSB7XG4gICAgICAgIGlmICghZXh0ZXJuLmlzRGVjbGFyYXRpb25GaWxlKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgb3V0cHV0QmFzZURpciA9IG9wdGlvbnMub3V0RGlyITtcbiAgICAgICAgY29uc3QgcmVsYXRpdmVPdXRwdXRQYXRoID1cbiAgICAgICAgICAgIGNvbXBpbGVySG9zdC5yZWxhdGl2ZU91dHB1dFBhdGgoZXh0ZXJuLmZpbGVOYW1lKTtcbiAgICAgICAgbWtkaXJwKG91dHB1dEJhc2VEaXIsIHBhdGguZGlybmFtZShyZWxhdGl2ZU91dHB1dFBhdGgpKTtcbiAgICAgICAgY29uc3Qgb3V0cHV0UGF0aCA9IHBhdGguam9pbihvdXRwdXRCYXNlRGlyLCByZWxhdGl2ZU91dHB1dFBhdGgpO1xuICAgICAgICBjb25zdCBtb2R1bGVOYW1lID0gY29tcGlsZXJIb3N0LnBhdGhUb01vZHVsZU5hbWUoJycsIGV4dGVybi5maWxlTmFtZSk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgICBvdXRwdXRQYXRoLFxuICAgICAgICAgICAgYGdvb2cubW9kdWxlKCcke21vZHVsZU5hbWV9Jyk7XFxuYCArXG4gICAgICAgICAgICAgICAgYC8vIEV4cG9ydCBhbiBlbXB0eSBvYmplY3Qgb2YgdW5rbm93biB0eXBlIHRvIGFsbG93IGltcG9ydHMuXFxuYCArXG4gICAgICAgICAgICAgICAgYC8vIFRPRE86IHVzZSB0eXBlb2Ygb25jZSBhdmFpbGFibGVcXG5gICtcbiAgICAgICAgICAgICAgICBgZXhwb3J0cyA9IC8qKiBAdHlwZSB7P30gKi8gKHt9KTtcXG5gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAoYmF6ZWxPcHRzLm1hbmlmZXN0KSB7XG4gICAgcGVyZlRyYWNlLndyYXAoJ21hbmlmZXN0JywgKCkgPT4ge1xuICAgICAgY29uc3QgbWFuaWZlc3QgPVxuICAgICAgICAgIGNvbnN0cnVjdE1hbmlmZXN0KGVtaXRSZXN1bHQubW9kdWxlc01hbmlmZXN0LCBjb21waWxlckhvc3QpO1xuICAgICAgZnMud3JpdGVGaWxlU3luYyhiYXplbE9wdHMubWFuaWZlc3QsIG1hbmlmZXN0KTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBkaWFnbm9zdGljcztcbn1cblxuLyoqXG4gKiBDcmVhdGVzIGRpcmVjdG9yaWVzIHN1YmRpciAoYSBzbGFzaCBzZXBhcmF0ZWQgcmVsYXRpdmUgcGF0aCkgc3RhcnRpbmcgZnJvbVxuICogYmFzZS5cbiAqL1xuZnVuY3Rpb24gbWtkaXJwKGJhc2U6IHN0cmluZywgc3ViZGlyOiBzdHJpbmcpIHtcbiAgY29uc3Qgc3RlcHMgPSBzdWJkaXIuc3BsaXQocGF0aC5zZXApO1xuICBsZXQgY3VycmVudCA9IGJhc2U7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc3RlcHMubGVuZ3RoOyBpKyspIHtcbiAgICBjdXJyZW50ID0gcGF0aC5qb2luKGN1cnJlbnQsIHN0ZXBzW2ldKTtcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMoY3VycmVudCkpIGZzLm1rZGlyU3luYyhjdXJyZW50KTtcbiAgfVxufVxuXG5cbi8qKlxuICogUmVzb2x2ZSBtb2R1bGUgZmlsZW5hbWVzIGZvciBKUyBtb2R1bGVzLlxuICpcbiAqIEpTIG1vZHVsZSByZXNvbHV0aW9uIG5lZWRzIHRvIGJlIGRpZmZlcmVudCBiZWNhdXNlIHdoZW4gdHJhbnNwaWxpbmcgSlMgd2VcbiAqIGRvIG5vdCBwYXNzIGluIGFueSBkZXBlbmRlbmNpZXMsIHNvIHRoZSBUUyBtb2R1bGUgcmVzb2x2ZXIgd2lsbCBub3QgcmVzb2x2ZVxuICogYW55IGZpbGVzLlxuICpcbiAqIEZvcnR1bmF0ZWx5LCBKUyBtb2R1bGUgcmVzb2x1dGlvbiBpcyB2ZXJ5IHNpbXBsZS4gVGhlIGltcG9ydGVkIG1vZHVsZSBuYW1lXG4gKiBtdXN0IGVpdGhlciBhIHJlbGF0aXZlIHBhdGgsIG9yIHRoZSB3b3Jrc3BhY2Ugcm9vdCAoaS5lLiAnZ29vZ2xlMycpLFxuICogc28gd2UgY2FuIHBlcmZvcm0gbW9kdWxlIHJlc29sdXRpb24gZW50aXJlbHkgYmFzZWQgb24gZmlsZSBuYW1lcywgd2l0aG91dFxuICogbG9va2luZyBhdCB0aGUgZmlsZXN5c3RlbS5cbiAqL1xuZnVuY3Rpb24gbWFrZUpzTW9kdWxlUmVzb2x2ZXIod29ya3NwYWNlTmFtZTogc3RyaW5nKSB7XG4gIC8vIFRoZSBsaXRlcmFsICcvJyBoZXJlIGlzIGNyb3NzLXBsYXRmb3JtIHNhZmUgYmVjYXVzZSBpdCdzIG1hdGNoaW5nIG9uXG4gIC8vIGltcG9ydCBzcGVjaWZpZXJzLCBub3QgZmlsZSBuYW1lcy5cbiAgY29uc3Qgd29ya3NwYWNlTW9kdWxlU3BlY2lmaWVyUHJlZml4ID0gYCR7d29ya3NwYWNlTmFtZX0vYDtcbiAgY29uc3Qgd29ya3NwYWNlRGlyID0gYCR7cGF0aC5zZXB9JHt3b3Jrc3BhY2VOYW1lfSR7cGF0aC5zZXB9YDtcbiAgZnVuY3Rpb24ganNNb2R1bGVSZXNvbHZlcihcbiAgICAgIG1vZHVsZU5hbWU6IHN0cmluZywgY29udGFpbmluZ0ZpbGU6IHN0cmluZyxcbiAgICAgIGNvbXBpbGVyT3B0aW9uczogdHMuQ29tcGlsZXJPcHRpb25zLCBob3N0OiB0cy5Nb2R1bGVSZXNvbHV0aW9uSG9zdCk6XG4gICAgICB0cy5SZXNvbHZlZE1vZHVsZVdpdGhGYWlsZWRMb29rdXBMb2NhdGlvbnMge1xuICAgIGxldCByZXNvbHZlZEZpbGVOYW1lO1xuICAgIGlmIChjb250YWluaW5nRmlsZSA9PT0gJycpIHtcbiAgICAgIC8vIEluIHRzaWNrbGUgd2UgcmVzb2x2ZSB0aGUgZmlsZW5hbWUgYWdhaW5zdCAnJyB0byBnZXQgdGhlIGdvb2cgbW9kdWxlXG4gICAgICAvLyBuYW1lIG9mIGEgc291cmNlZmlsZS5cbiAgICAgIHJlc29sdmVkRmlsZU5hbWUgPSBtb2R1bGVOYW1lO1xuICAgIH0gZWxzZSBpZiAobW9kdWxlTmFtZS5zdGFydHNXaXRoKHdvcmtzcGFjZU1vZHVsZVNwZWNpZmllclByZWZpeCkpIHtcbiAgICAgIC8vIEdpdmVuIGEgd29ya3NwYWNlIG5hbWUgb2YgJ2ZvbycsIHdlIHdhbnQgdG8gcmVzb2x2ZSBpbXBvcnQgc3BlY2lmaWVyc1xuICAgICAgLy8gbGlrZTogJ2Zvby9wcm9qZWN0L2ZpbGUuanMnIHRvIHRoZSBhYnNvbHV0ZSBmaWxlc3lzdGVtIHBhdGggb2ZcbiAgICAgIC8vIHByb2plY3QvZmlsZS5qcyB3aXRoaW4gdGhlIHdvcmtzcGFjZS5cbiAgICAgIGNvbnN0IHdvcmtzcGFjZURpckxvY2F0aW9uID0gY29udGFpbmluZ0ZpbGUuaW5kZXhPZih3b3Jrc3BhY2VEaXIpO1xuICAgICAgaWYgKHdvcmtzcGFjZURpckxvY2F0aW9uIDwgMCkge1xuICAgICAgICByZXR1cm4ge3Jlc29sdmVkTW9kdWxlOiB1bmRlZmluZWR9O1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzb2x1dGVQYXRoVG9Xb3Jrc3BhY2VEaXIgPVxuICAgICAgICAgIGNvbnRhaW5pbmdGaWxlLnNsaWNlKDAsIHdvcmtzcGFjZURpckxvY2F0aW9uKTtcbiAgICAgIHJlc29sdmVkRmlsZU5hbWUgPSBwYXRoLmpvaW4oYWJzb2x1dGVQYXRoVG9Xb3Jrc3BhY2VEaXIsIG1vZHVsZU5hbWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIW1vZHVsZU5hbWUuc3RhcnRzV2l0aCgnLi8nKSAmJiAhbW9kdWxlTmFtZS5zdGFydHNXaXRoKCcuLi8nKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgVW5zdXBwb3J0ZWQgbW9kdWxlIGltcG9ydCBzcGVjaWZpZXI6ICR7XG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobW9kdWxlTmFtZSl9LlxcbmAgK1xuICAgICAgICAgICAgYEpTIG1vZHVsZSBpbXBvcnRzIG11c3QgZWl0aGVyIGJlIHJlbGF0aXZlIHBhdGhzIGAgK1xuICAgICAgICAgICAgYChiZWdpbm5pbmcgd2l0aCAnLicgb3IgJy4uJyksIGAgK1xuICAgICAgICAgICAgYG9yIHRoZXkgbXVzdCBiZWdpbiB3aXRoICcke3dvcmtzcGFjZU5hbWV9LycuYCk7XG4gICAgICB9XG4gICAgICByZXNvbHZlZEZpbGVOYW1lID0gcGF0aC5qb2luKHBhdGguZGlybmFtZShjb250YWluaW5nRmlsZSksIG1vZHVsZU5hbWUpO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcmVzb2x2ZWRNb2R1bGU6IHtcbiAgICAgICAgcmVzb2x2ZWRGaWxlTmFtZSxcbiAgICAgICAgZXh0ZW5zaW9uOiB0cy5FeHRlbnNpb24uSnMsICAvLyBqcyBjYW4gb25seSBpbXBvcnQganNcbiAgICAgICAgLy8gVGhlc2UgdHdvIGZpZWxkcyBhcmUgY2FyZ28gY3VsdGVkIGZyb20gd2hhdCB0cy5yZXNvbHZlTW9kdWxlTmFtZVxuICAgICAgICAvLyBzZWVtcyB0byByZXR1cm4uXG4gICAgICAgIHBhY2thZ2VJZDogdW5kZWZpbmVkLFxuICAgICAgICBpc0V4dGVybmFsTGlicmFyeUltcG9ydDogZmFsc2UsXG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiBqc01vZHVsZVJlc29sdmVyO1xufVxuXG5cbmlmIChyZXF1aXJlLm1haW4gPT09IG1vZHVsZSkge1xuICAvLyBEbyBub3QgY2FsbCBwcm9jZXNzLmV4aXQoKSwgYXMgdGhhdCB0ZXJtaW5hdGVzIHRoZSBiaW5hcnkgYmVmb3JlXG4gIC8vIGNvbXBsZXRpbmcgcGVuZGluZyBvcGVyYXRpb25zLCBzdWNoIGFzIHdyaXRpbmcgdG8gc3Rkb3V0IG9yIGVtaXR0aW5nIHRoZVxuICAvLyB2OCBwZXJmb3JtYW5jZSBsb2cuIFJhdGhlciwgc2V0IHRoZSBleGl0IGNvZGUgYW5kIGZhbGwgb2ZmIHRoZSBtYWluXG4gIC8vIHRocmVhZCwgd2hpY2ggd2lsbCBjYXVzZSBub2RlIHRvIHRlcm1pbmF0ZSBjbGVhbmx5LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIl19