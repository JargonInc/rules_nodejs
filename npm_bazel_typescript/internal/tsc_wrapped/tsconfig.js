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
        define(["require", "exports", "path", "typescript"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const path = require("path");
    const ts = require("typescript");
    /**
     * Prints messages to stderr if the given config object contains certain known
     * properties that Bazel will override in the generated tsconfig.json.
     * Note that this is not an exhaustive list of such properties; just the ones
     * thought to commonly cause problems.
     * Note that we can't error out, because users might have a legitimate reason:
     * - during a transition to Bazel they can use the same tsconfig with other
     *   tools
     * - if they have multiple packages in their repo, they might need to use path
     *   mapping so the editor knows where to resolve some absolute imports
     *
     * @param userConfig the parsed json for the full tsconfig.json file
     */
    function warnOnOverriddenOptions(userConfig) {
        const overrideWarnings = [];
        if (userConfig.files) {
            overrideWarnings.push('files is ignored because it is controlled by the srcs[] attribute');
        }
        const options = userConfig.compilerOptions;
        if (options) {
            if (options.target || options.module) {
                overrideWarnings.push('compilerOptions.target and compilerOptions.module are controlled by downstream dependencies, such as ts_devserver');
            }
            if (options.declaration) {
                overrideWarnings.push(`compilerOptions.declaration is always true, as it's needed for dependent libraries to type-check`);
            }
            if (options.paths) {
                overrideWarnings.push('compilerOptions.paths is determined by the module_name attribute in transitive deps[]');
            }
            if (options.typeRoots) {
                overrideWarnings.push('compilerOptions.typeRoots is always set to the @types subdirectory of the node_modules attribute');
            }
            if (options.traceResolution || options.diagnostics) {
                overrideWarnings.push('compilerOptions.traceResolution and compilerOptions.diagnostics are set by the DEBUG flag in tsconfig.bzl under rules_typescript');
            }
            if (options.rootDir || options.baseUrl) {
                overrideWarnings.push('compilerOptions.rootDir and compilerOptions.baseUrl are always the workspace root directory');
            }
            if (options.preserveConstEnums) {
                overrideWarnings.push('compilerOptions.preserveConstEnums is always false under Bazel');
            }
            if (options.noEmitOnError) {
                // TODO(alexeagle): why??
                overrideWarnings.push('compilerOptions.noEmitOnError is always false under Bazel');
            }
        }
        if (overrideWarnings.length) {
            console.error('\nWARNING: your tsconfig.json file specifies options which are overridden by Bazel:');
            for (const w of overrideWarnings)
                console.error(` - ${w}`);
            console.error('\n');
        }
    }
    /**
     * The same as Node's path.resolve, however it returns a path with forward
     * slashes rather than joining the resolved path with the platform's path
     * separator.
     * Note that even path.posix.resolve('.') returns C:\Users\... with backslashes.
     */
    function resolveNormalizedPath(...segments) {
        return path.resolve(...segments).replace(/\\/g, '/');
    }
    exports.resolveNormalizedPath = resolveNormalizedPath;
    /**
     * Load a tsconfig.json and convert all referenced paths (including
     * bazelOptions) to absolute paths.
     * Paths seen by TypeScript should be absolute, to match behavior
     * of the tsc ModuleResolution implementation.
     * @param tsconfigFile path to tsconfig, relative to process.cwd() or absolute
     * @return configuration parsed from the file, or error diagnostics
     */
    function parseTsconfig(tsconfigFile, host = ts.sys) {
        // TypeScript expects an absolute path for the tsconfig.json file
        tsconfigFile = resolveNormalizedPath(tsconfigFile);
        const isUndefined = (value) => value === undefined;
        // Handle bazel specific options, but make sure not to crash when reading a
        // vanilla tsconfig.json.
        const readExtendedConfigFile = (configFile, existingConfig) => {
            const { config, error } = ts.readConfigFile(configFile, host.readFile);
            if (error) {
                return { error };
            }
            // Allow Bazel users to control some of the bazel options.
            // Since TypeScript's "extends" mechanism applies only to "compilerOptions"
            // we have to repeat some of their logic to get the user's bazelOptions.
            const mergedConfig = existingConfig || config;
            if (existingConfig) {
                const existingBazelOpts = existingConfig.bazelOptions || {};
                const newBazelBazelOpts = config.bazelOptions || {};
                mergedConfig.bazelOptions = Object.assign({}, existingBazelOpts, { disableStrictDeps: isUndefined(existingBazelOpts.disableStrictDeps)
                        ? newBazelBazelOpts.disableStrictDeps
                        : existingBazelOpts.disableStrictDeps, suppressTsconfigOverrideWarnings: isUndefined(existingBazelOpts.suppressTsconfigOverrideWarnings)
                        ? newBazelBazelOpts.suppressTsconfigOverrideWarnings
                        : existingBazelOpts.suppressTsconfigOverrideWarnings, tsickle: isUndefined(existingBazelOpts.tsickle)
                        ? newBazelBazelOpts.tsickle
                        : existingBazelOpts.tsickle, googmodule: isUndefined(existingBazelOpts.googmodule)
                        ? newBazelBazelOpts.googmodule
                        : existingBazelOpts.googmodule, devmodeTargetOverride: isUndefined(existingBazelOpts.devmodeTargetOverride)
                        ? newBazelBazelOpts.devmodeTargetOverride
                        : existingBazelOpts.devmodeTargetOverride });
                if (!mergedConfig.bazelOptions.suppressTsconfigOverrideWarnings) {
                    warnOnOverriddenOptions(config);
                }
            }
            if (config.extends) {
                let extendedConfigPath = resolveNormalizedPath(path.dirname(configFile), config.extends);
                if (!extendedConfigPath.endsWith('.json'))
                    extendedConfigPath += '.json';
                return readExtendedConfigFile(extendedConfigPath, mergedConfig);
            }
            return { config: mergedConfig };
        };
        const { config, error } = readExtendedConfigFile(tsconfigFile);
        if (error) {
            // target is in the config file we failed to load...
            return [null, [error], { target: '' }];
        }
        const { options, errors, fileNames } = ts.parseJsonConfigFileContent(config, host, path.dirname(tsconfigFile));
        // Handle bazel specific options, but make sure not to crash when reading a
        // vanilla tsconfig.json.
        const bazelOpts = config.bazelOptions || {};
        const target = bazelOpts.target;
        bazelOpts.allowedStrictDeps = bazelOpts.allowedStrictDeps || [];
        bazelOpts.typeBlackListPaths = bazelOpts.typeBlackListPaths || [];
        bazelOpts.compilationTargetSrc = bazelOpts.compilationTargetSrc || [];
        if (errors && errors.length) {
            return [null, errors, { target }];
        }
        // Override the devmode target if devmodeTargetOverride is set
        if (bazelOpts.es5Mode && bazelOpts.devmodeTargetOverride) {
            switch (bazelOpts.devmodeTargetOverride.toLowerCase()) {
                case 'es3':
                    options.target = ts.ScriptTarget.ES3;
                    break;
                case 'es5':
                    options.target = ts.ScriptTarget.ES5;
                    break;
                case 'es2015':
                    options.target = ts.ScriptTarget.ES2015;
                    break;
                case 'es2016':
                    options.target = ts.ScriptTarget.ES2016;
                    break;
                case 'es2017':
                    options.target = ts.ScriptTarget.ES2017;
                    break;
                case 'es2018':
                    options.target = ts.ScriptTarget.ES2018;
                    break;
                case 'esnext':
                    options.target = ts.ScriptTarget.ESNext;
                    break;
                default:
                    console.error('WARNING: your tsconfig.json file specifies an invalid bazelOptions.devmodeTargetOverride value of: \'${bazelOpts.devmodeTargetOverride\'');
            }
        }
        // Sort rootDirs with longest include directories first.
        // When canonicalizing paths, we always want to strip
        // `workspace/bazel-bin/file` to just `file`, not to `bazel-bin/file`.
        if (options.rootDirs)
            options.rootDirs.sort((a, b) => b.length - a.length);
        // If the user requested goog.module, we need to produce that output even if
        // the generated tsconfig indicates otherwise.
        if (bazelOpts.googmodule)
            options.module = ts.ModuleKind.CommonJS;
        // TypeScript's parseJsonConfigFileContent returns paths that are joined, eg.
        // /path/to/project/bazel-out/arch/bin/path/to/package/../../../../../../path
        // We normalize them to remove the intermediate parent directories.
        // This improves error messages and also matches logic in tsc_wrapped where we
        // expect normalized paths.
        const files = fileNames.map(f => path.posix.normalize(f));
        // The bazelOpts paths in the tsconfig are relative to
        // options.rootDir (the workspace root) and aren't transformed by
        // parseJsonConfigFileContent (because TypeScript doesn't know
        // about them). Transform them to also be absolute here.
        bazelOpts.compilationTargetSrc = bazelOpts.compilationTargetSrc.map(f => resolveNormalizedPath(options.rootDir, f));
        bazelOpts.allowedStrictDeps = bazelOpts.allowedStrictDeps.map(f => resolveNormalizedPath(options.rootDir, f));
        bazelOpts.typeBlackListPaths = bazelOpts.typeBlackListPaths.map(f => resolveNormalizedPath(options.rootDir, f));
        if (bazelOpts.nodeModulesPrefix) {
            bazelOpts.nodeModulesPrefix =
                resolveNormalizedPath(options.rootDir, bazelOpts.nodeModulesPrefix);
        }
        let disabledTsetseRules = [];
        for (const pluginConfig of options['plugins'] ||
            []) {
            if (pluginConfig.name && pluginConfig.name === '@bazel/tsetse') {
                const disabledRules = pluginConfig['disabledRules'];
                if (disabledRules && !Array.isArray(disabledRules)) {
                    throw new Error('Disabled tsetse rules must be an array of rule names');
                }
                disabledTsetseRules = disabledRules;
                break;
            }
        }
        return [
            { options, bazelOpts, files, config, disabledTsetseRules }, null, { target }
        ];
    }
    exports.parseTsconfig = parseTsconfig;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHNjb25maWcuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzY193cmFwcGVkL3RzY29uZmlnLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7R0FlRzs7Ozs7Ozs7Ozs7O0lBRUgsNkJBQTZCO0lBQzdCLGlDQUFpQztJQStMakM7Ozs7Ozs7Ozs7OztPQVlHO0lBQ0gsU0FBUyx1QkFBdUIsQ0FBQyxVQUFlO1FBQzlDLE1BQU0sZ0JBQWdCLEdBQWEsRUFBRSxDQUFDO1FBQ3RDLElBQUksVUFBVSxDQUFDLEtBQUssRUFBRTtZQUNwQixnQkFBZ0IsQ0FBQyxJQUFJLENBQ2pCLG1FQUFtRSxDQUFDLENBQUM7U0FDMUU7UUFDRCxNQUFNLE9BQU8sR0FBdUIsVUFBVSxDQUFDLGVBQWUsQ0FBQztRQUMvRCxJQUFJLE9BQU8sRUFBRTtZQUNYLElBQUksT0FBTyxDQUFDLE1BQU0sSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFO2dCQUNwQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQ2pCLG1IQUFtSCxDQUFDLENBQUM7YUFDMUg7WUFDRCxJQUFJLE9BQU8sQ0FBQyxXQUFXLEVBQUU7Z0JBQ3ZCLGdCQUFnQixDQUFDLElBQUksQ0FDakIsa0dBQWtHLENBQUMsQ0FBQzthQUN6RztZQUNELElBQUksT0FBTyxDQUFDLEtBQUssRUFBRTtnQkFDakIsZ0JBQWdCLENBQUMsSUFBSSxDQUNqQix1RkFBdUYsQ0FBQyxDQUFDO2FBQzlGO1lBQ0QsSUFBSSxPQUFPLENBQUMsU0FBUyxFQUFFO2dCQUNyQixnQkFBZ0IsQ0FBQyxJQUFJLENBQ2pCLGtHQUFrRyxDQUFDLENBQUM7YUFDekc7WUFDRCxJQUFJLE9BQU8sQ0FBQyxlQUFlLElBQUssT0FBZSxDQUFDLFdBQVcsRUFBRTtnQkFDM0QsZ0JBQWdCLENBQUMsSUFBSSxDQUNqQixr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QUFDO0lBdEtELHNDQXNLQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGxpY2Vuc2VcbiAqIENvcHlyaWdodCAyMDE3IFRoZSBCYXplbCBBdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLlxuICpcbiAqIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gKiB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gKlxuICogWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG4gKiAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgdHMgZnJvbSAndHlwZXNjcmlwdCc7XG5cbi8qKlxuICogVGhlIGNvbmZpZ3VyYXRpb24gYmxvY2sgcHJvdmlkZWQgYnkgdGhlIHRzY29uZmlnIFwiYmF6ZWxPcHRpb25zXCIuXG4gKiBOb3RlIHRoYXQgYWxsIHBhdGhzIGhlcmUgYXJlIHJlbGF0aXZlIHRvIHRoZSByb290RGlyLCBub3QgYWJzb2x1dGUgbm9yXG4gKiByZWxhdGl2ZSB0byB0aGUgbG9jYXRpb24gY29udGFpbmluZyB0aGUgdHNjb25maWcgZmlsZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBCYXplbE9wdGlvbnMge1xuICAvKiogTmFtZSBvZiB0aGUgYmF6ZWwgd29ya3NwYWNlIHdoZXJlIHdlIGFyZSBidWlsZGluZy4gKi9cbiAgd29ya3NwYWNlTmFtZTogc3RyaW5nO1xuXG4gIC8qKiBUaGUgZnVsbCBiYXplbCB0YXJnZXQgdGhhdCBpcyBiZWluZyBidWlsdCwgZS5nLiAvL215L3BrZzpsaWJyYXJ5LiAqL1xuICB0YXJnZXQ6IHN0cmluZztcblxuICAvKiogVGhlIGJhemVsIHBhY2thZ2UsIGVnIG15L3BrZyAqL1xuICBwYWNrYWdlOiBzdHJpbmc7XG5cbiAgLyoqIElmIHRydWUsIGNvbnZlcnQgcmVxdWlyZSgpcyBpbnRvIGdvb2cubW9kdWxlKCkuICovXG4gIGdvb2dtb2R1bGU6IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIElmIHRydWUsIGVtaXQgZGV2bW9kZSBvdXRwdXQgaW50byBmaWxlbmFtZS5qcy5cbiAgICogSWYgZmFsc2UsIGVtaXQgcHJvZG1vZGUgb3V0cHV0IGludG8gZmlsZW5hbWUuY2xvc3VyZS5qcy5cbiAgICovXG4gIGVzNU1vZGU6IGJvb2xlYW47XG5cbiAgLyoqIElmIHRydWUsIGNvbnZlcnQgVHlwZVNjcmlwdCBjb2RlIGludG8gYSBDbG9zdXJlLWNvbXBhdGlibGUgdmFyaWFudC4gKi9cbiAgdHNpY2tsZTogYm9vbGVhbjtcblxuICAvKiogSWYgdHJ1ZSwgZ2VuZXJhdGUgZXh0ZXJucyBmcm9tIGRlY2xhcmF0aW9ucyBpbiBkLnRzIGZpbGVzLiAqL1xuICB0c2lja2xlR2VuZXJhdGVFeHRlcm5zOiBib29sZWFuO1xuXG4gIC8qKiBXcml0ZSBnZW5lcmF0ZWQgZXh0ZXJucyB0byB0aGUgZ2l2ZW4gcGF0aC4gKi9cbiAgdHNpY2tsZUV4dGVybnNQYXRoOiBzdHJpbmc7XG5cbiAgLyoqIFBhdGhzIG9mIGRlY2xhcmF0aW9ucyB3aG9zZSB0eXBlcyBtdXN0IG5vdCBhcHBlYXIgaW4gcmVzdWx0IC5kLnRzLiAqL1xuICB0eXBlQmxhY2tMaXN0UGF0aHM6IHN0cmluZ1tdO1xuXG4gIC8qKiBJZiB0cnVlLCBlbWl0IENsb3N1cmUgdHlwZXMgaW4gVHlwZVNjcmlwdC0+SlMgb3V0cHV0LiAqL1xuICB1bnR5cGVkOiBib29sZWFuO1xuXG4gIC8qKiBUaGUgbGlzdCBvZiBzb3VyY2VzIHdlJ3JlIGludGVyZXN0ZWQgaW4gKGVtaXR0aW5nIGFuZCB0eXBlIGNoZWNraW5nKS4gKi9cbiAgY29tcGlsYXRpb25UYXJnZXRTcmM6IHN0cmluZ1tdO1xuXG4gIC8qKiBQYXRoIHRvIHdyaXRlIHRoZSBtb2R1bGUgZGVwZW5kZW5jeSBtYW5pZmVzdCB0by4gKi9cbiAgbWFuaWZlc3Q6IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciB0byBkaXNhYmxlIHN0cmljdCBkZXBzIGNoZWNrLiBJZiB0cnVlIHRoZSBuZXh0IHBhcmFtZXRlciBpc1xuICAgKiBpZ25vcmVkLlxuICAgKi9cbiAgZGlzYWJsZVN0cmljdERlcHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBQYXRocyBvZiBkZXBlbmRlbmNpZXMgdGhhdCBhcmUgYWxsb3dlZCBieSBzdHJpY3QgZGVwcywgaS5lLiB0aGF0IG1heSBiZVxuICAgKiBpbXBvcnRlZCBieSB0aGUgc291cmNlIGZpbGVzIGluIGNvbXBpbGF0aW9uVGFyZ2V0U3JjLlxuICAgKi9cbiAgYWxsb3dlZFN0cmljdERlcHM6IHN0cmluZ1tdO1xuXG4gIC8qKiBXcml0ZSBhIHBlcmZvcm1hbmNlIHRyYWNlIHRvIHRoaXMgcGF0aC4gRGlzYWJsZWQgd2hlbiBmYWxzeS4gKi9cbiAgcGVyZlRyYWNlUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogQW4gYWRkaXRpb25hbCBwcmVsdWRlIHRvIGluc2VydCBhZnRlciB0aGUgYGdvb2cubW9kdWxlYCBjYWxsLFxuICAgKiBlLmcuIHdpdGggYWRkaXRpb25hbCBpbXBvcnRzIG9yIHJlcXVpcmVzLlxuICAgKi9cbiAgcHJlbHVkZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBOYW1lIG9mIHRoZSBjdXJyZW50IGxvY2FsZSBpZiBwcm9jZXNzaW5nIGEgbG9jYWxlLXNwZWNpZmljIGZpbGUuXG4gICAqL1xuICBsb2NhbGU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEEgbGlzdCBvZiBlcnJvcnMgdGhpcyBjb21waWxhdGlvbiBpcyBleHBlY3RlZCB0byBnZW5lcmF0ZSwgaW4gdGhlIGZvcm1cbiAgICogXCJUUzEyMzQ6cmVnZXhwXCIuIElmIGVtcHR5LCBjb21waWxhdGlvbiBpcyBleHBlY3RlZCB0byBzdWNjZWVkLlxuICAgKi9cbiAgZXhwZWN0ZWREaWFnbm9zdGljczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRvIHN1cHBvcnQgbm9kZV9tb2R1bGUgcmVzb2x1dGlvbiwgYWxsb3cgVHlwZVNjcmlwdCB0byBtYWtlIGFyYml0cmFyeVxuICAgKiBmaWxlIHN5c3RlbSBhY2Nlc3MgdG8gcGF0aHMgdW5kZXIgdGhpcyBwcmVmaXguXG4gICAqL1xuICBub2RlTW9kdWxlc1ByZWZpeDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBMaXN0IG9mIHJlZ2V4ZXMgb24gZmlsZSBwYXRocyBmb3Igd2hpY2ggd2Ugc3VwcHJlc3MgdHNpY2tsZSdzIHdhcm5pbmdzLlxuICAgKi9cbiAgaWdub3JlV2FybmluZ1BhdGhzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBhZGQgYWxpYXNlcyB0byB0aGUgLmQudHMgZmlsZXMgdG8gYWRkIHRoZSBleHBvcnRzIHRvIHRoZVxuICAgKiDgsqBf4LKgLmNsdXR6IG5hbWVzcGFjZS5cbiAgICovXG4gIGFkZER0c0NsdXR6QWxpYXNlczogdHJ1ZTtcblxuICAvKipcbiAgICogV2hldGhlciB0byB0eXBlIGNoZWNrIGlucHV0cyB0aGF0IGFyZW4ndCBzcmNzLiAgRGlmZmVycyBmcm9tXG4gICAqIC0tc2tpcExpYkNoZWNrLCB3aGljaCBza2lwcyBhbGwgLmQudHMgZmlsZXMsIGV2ZW4gdGhvc2Ugd2hpY2ggYXJlXG4gICAqIHNyY3MuXG4gICAqL1xuICB0eXBlQ2hlY2tEZXBlbmRlbmNpZXM6IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIGNhY2hlIHNpemUgZm9yIGJhemVsIG91dHB1dHMsIGluIG1lZ2FieXRlcy5cbiAgICovXG4gIG1heENhY2hlU2l6ZU1iPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTdXBwcmVzcyB3YXJuaW5ncyBhYm91dCB0c2NvbmZpZy5qc29uIHByb3BlcnRpZXMgdGhhdCBhcmUgb3ZlcnJpZGRlbi5cbiAgICovXG4gIHN1cHByZXNzVHNjb25maWdPdmVycmlkZVdhcm5pbmdzOiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBBbiBleHBsaWNpdCBuYW1lIGZvciB0aGlzIG1vZHVsZSwgZ2l2ZW4gYnkgdGhlIG1vZHVsZV9uYW1lIGF0dHJpYnV0ZSBvbiBhXG4gICAqIHRzX2xpYnJhcnkuXG4gICAqL1xuICBtb2R1bGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBbiBleHBsaWNpdCBlbnRyeSBwb2ludCBmb3IgdGhpcyBtb2R1bGUsIGdpdmVuIGJ5IHRoZSBtb2R1bGVfcm9vdCBhdHRyaWJ1dGVcbiAgICogb24gYSB0c19saWJyYXJ5LlxuICAgKi9cbiAgbW9kdWxlUm9vdD86IHN0cmluZztcblxuICAvKipcbiAgICogSWYgdHJ1ZSwgaW5kaWNhdGVzIHRoYXQgdGhpcyBqb2IgaXMgdHJhbnNwaWxpbmcgSlMgc291cmNlcy4gSWYgdHJ1ZSwgb25seVxuICAgKiBvbmUgZmlsZSBjYW4gYXBwZWFyIGluIGNvbXBpbGF0aW9uVGFyZ2V0U3JjLCBhbmQgZWl0aGVyXG4gICAqIHRyYW5zcGlsZWRKc091dHB1dEZpbGVOYW1lIG9yIHRoZSB0cmFuc3BpbGVkSnMqRGlyZWN0b3J5IG9wdGlvbnMgbXVzdCBiZVxuICAgKiBzZXQuXG4gICAqL1xuICBpc0pzVHJhbnNwaWxhdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRoZSBwYXRoIHdoZXJlIHRoZSBmaWxlIGNvbnRhaW5pbmcgdGhlIEpTIHRyYW5zcGlsZWQgb3V0cHV0IHNob3VsZCBiZVxuICAgKiB3cml0dGVuLiBJZ25vcmVkIGlmIGlzSnNUcmFuc3BpbGF0aW9uIGlzIGZhbHNlLiB0cmFuc3BpbGVkSnNPdXRwdXRGaWxlTmFtZVxuICAgKlxuICAgKi9cbiAgdHJhbnNwaWxlZEpzT3V0cHV0RmlsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBwYXRoIHdoZXJlIHRyYW5zcGlsZWQgSlMgb3V0cHV0IHNob3VsZCBiZSB3cml0dGVuLiBJZ25vcmVkIGlmXG4gICAqIGlzSnNUcmFuc3BpbGF0aW9uIGlzIGZhbHNlLiBNdXN0IG5vdCBiZSBzZXQgdG9nZXRoZXIgd2l0aFxuICAgKiB0cmFuc3BpbGVkSnNPdXRwdXRGaWxlTmFtZS5cbiAgICovXG4gIHRyYW5zcGlsZWRKc0lucHV0RGlyZWN0b3J5Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgcGF0aCB3aGVyZSB0cmFuc3BpbGVkIEpTIG91dHB1dCBzaG91bGQgYmUgd3JpdHRlbi4gSWdub3JlZCBpZlxuICAgKiBpc0pzVHJhbnNwaWxhdGlvbiBpcyBmYWxzZS4gTXVzdCBub3QgYmUgc2V0IHRvZ2V0aGVyIHdpdGhcbiAgICogdHJhbnNwaWxlZEpzT3V0cHV0RmlsZU5hbWUuXG4gICAqL1xuICB0cmFuc3BpbGVkSnNPdXRwdXREaXJlY3Rvcnk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHVzZXIgcHJvdmlkZWQgYW4gaW1wbGVtZW50YXRpb24gc2hpbSBmb3IgLmQudHMgZmlsZXMgaW4gdGhlXG4gICAqIGNvbXBpbGF0aW9uIHVuaXQuXG4gICAqL1xuICBoYXNJbXBsZW1lbnRhdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEVuYWJsZSB0aGUgQW5ndWxhciBuZ3RzYyBwbHVnaW4uXG4gICAqL1xuICBjb21waWxlQW5ndWxhclRlbXBsYXRlcz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE92ZXJyaWRlIGZvciBFQ01BU2NyaXB0IHRhcmdldCBsYW5ndWFnZSBsZXZlbCB0byB1c2UgZm9yIGRldm1vZGUuXG4gICAqXG4gICAqIFRoaXMgc2V0dGluZyBjYW4gYmUgc2V0IGluIGEgdXNlcidzIHRzY29uZmlnIHRvIG92ZXJyaWRlIHRoZSBkZWZhdWx0XG4gICAqIGRldm1vZGUgdGFyZ2V0LlxuICAgKlxuICAgKiBFWFBFUklNRU5UQUw6IFRoaXMgc2V0dGluZyBpcyBleHBlcmltZW50YWwgYW5kIG1heSBiZSByZW1vdmVkIGluIHRoZVxuICAgKiBmdXR1cmUuXG4gICAqL1xuICBkZXZtb2RlVGFyZ2V0T3ZlcnJpZGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFyc2VkVHNDb25maWcge1xuICBvcHRpb25zOiB0cy5Db21waWxlck9wdGlvbnM7XG4gIGJhemVsT3B0czogQmF6ZWxPcHRpb25zO1xuICBhbmd1bGFyQ29tcGlsZXJPcHRpb25zPzoge1trOiBzdHJpbmddOiB1bmtub3dufTtcbiAgZmlsZXM6IHN0cmluZ1tdO1xuICBkaXNhYmxlZFRzZXRzZVJ1bGVzOiBzdHJpbmdbXTtcbiAgY29uZmlnOiB7fTtcbn1cblxuLy8gVE9ETyhjYWxlYmVnZyk6IFVwc3RyZWFtP1xuaW50ZXJmYWNlIFBsdWdpbkltcG9ydFdpdGhDb25maWcgZXh0ZW5kcyB0cy5QbHVnaW5JbXBvcnQge1xuICBbb3B0aW9uTmFtZTogc3RyaW5nXTogc3RyaW5nfHt9O1xufVxuXG4vKipcbiAqIFByaW50cyBtZXNzYWdlcyB0byBzdGRlcnIgaWYgdGhlIGdpdmVuIGNvbmZpZyBvYmplY3QgY29udGFpbnMgY2VydGFpbiBrbm93blxuICogcHJvcGVydGllcyB0aGF0IEJhemVsIHdpbGwgb3ZlcnJpZGUgaW4gdGhlIGdlbmVyYXRlZCB0c2NvbmZpZy5qc29uLlxuICogTm90ZSB0aGF0IHRoaXMgaXMgbm90IGFuIGV4aGF1c3RpdmUgbGlzdCBvZiBzdWNoIHByb3BlcnRpZXM7IGp1c3QgdGhlIG9uZXNcbiAqIHRob3VnaHQgdG8gY29tbW9ubHkgY2F1c2UgcHJvYmxlbXMuXG4gKiBOb3RlIHRoYXQgd2UgY2FuJ3QgZXJyb3Igb3V0LCBiZWNhdXNlIHVzZXJzIG1pZ2h0IGhhdmUgYSBsZWdpdGltYXRlIHJlYXNvbjpcbiAqIC0gZHVyaW5nIGEgdHJhbnNpdGlvbiB0byBCYXplbCB0aGV5IGNhbiB1c2UgdGhlIHNhbWUgdHNjb25maWcgd2l0aCBvdGhlclxuICogICB0b29sc1xuICogLSBpZiB0aGV5IGhhdmUgbXVsdGlwbGUgcGFja2FnZXMgaW4gdGhlaXIgcmVwbywgdGhleSBtaWdodCBuZWVkIHRvIHVzZSBwYXRoXG4gKiAgIG1hcHBpbmcgc28gdGhlIGVkaXRvciBrbm93cyB3aGVyZSB0byByZXNvbHZlIHNvbWUgYWJzb2x1dGUgaW1wb3J0c1xuICpcbiAqIEBwYXJhbSB1c2VyQ29uZmlnIHRoZSBwYXJzZWQganNvbiBmb3IgdGhlIGZ1bGwgdHNjb25maWcuanNvbiBmaWxlXG4gKi9cbmZ1bmN0aW9uIHdhcm5Pbk92ZXJyaWRkZW5PcHRpb25zKHVzZXJDb25maWc6IGFueSkge1xuICBjb25zdCBvdmVycmlkZVdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAodXNlckNvbmZpZy5maWxlcykge1xuICAgIG92ZXJyaWRlV2FybmluZ3MucHVzaChcbiAgICAgICAgJ2ZpbGVzIGlzIGlnbm9yZWQgYmVjYXVzZSBpdCBpcyBjb250cm9sbGVkIGJ5IHRoZSBzcmNzW10gYXR0cmlidXRlJyk7XG4gIH1cbiAgY29uc3Qgb3B0aW9uczogdHMuQ29tcGlsZXJPcHRpb25zID0gdXNlckNvbmZpZy5jb21waWxlck9wdGlvbnM7XG4gIGlmIChvcHRpb25zKSB7XG4gICAgaWYgKG9wdGlvbnMudGFyZ2V0IHx8IG9wdGlvbnMubW9kdWxlKSB7XG4gICAgICBvdmVycmlkZVdhcm5pbmdzLnB1c2goXG4gICAgICAgICAgJ2NvbXBpbGVyT3B0aW9ucy50YXJnZXQgYW5kIGNvbXBpbGVyT3B0aW9ucy5tb2R1bGUgYXJlIGNvbnRyb2xsZWQgYnkgZG93bnN0cmVhbSBkZXBlbmRlbmNpZXMsIHN1Y2ggYXMgdHNfZGV2c2VydmVyJyk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLmRlY2xhcmF0aW9uKSB7XG4gICAgICBvdmVycmlkZVdhcm5pbmdzLnB1c2goXG4gICAgICAgICAgYGNvbXBpbGVyT3B0aW9ucy5kZWNsYXJhdGlvbiBpcyBhbHdheXMgdHJ1ZSwgYXMgaXQncyBuZWVkZWQgZm9yIGRlcGVuZGVudCBsaWJyYXJpZXMgdG8gdHlwZS1jaGVja2ApO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy5wYXRocykge1xuICAgICAgb3ZlcnJpZGVXYXJuaW5ncy5wdXNoKFxuICAgICAgICAgICdjb21waWxlck9wdGlvbnMucGF0aHMgaXMgZGV0ZXJtaW5lZCBieSB0aGUgbW9kdWxlX25hbWUgYXR0cmlidXRlIGluIHRyYW5zaXRpdmUgZGVwc1tdJyk7XG4gICAgfVxuICAgIGlmIChvcHRpb25zLnR5cGVSb290cykge1xuICAgICAgb3ZlcnJpZGVXYXJuaW5ncy5wdXNoKFxuICAgICAgICAgICdjb21waWxlck9wdGlvbnMudHlwZVJvb3RzIGlzIGFsd2F5cyBzZXQgdG8gdGhlIEB0eXBlcyBzdWJkaXJlY3Rvcnkgb2YgdGhlIG5vZGVfbW9kdWxlcyBhdHRyaWJ1dGUnKTtcbiAgICB9XG4gICAgaWYgKG9wdGlvbnMudHJhY2VSZXNvbHV0aW9uIHx8IChvcHRpb25zIGFzIGFueSkuZGlhZ25vc3RpY3MpIHtcbiAgICAgIG92ZXJyaWRlV2FybmluZ3MucHVzaChcbiAgICAgICAgICAnY29tcGlsZXJPcHRpb25zLnRyYWNlUmVzb2x1dGlvbiBhbmQgY29tcGlsZXJPcHRpb25zLmRpYWdub3N0aWNzIGFyZSBzZXQgYnkgdGhlIERFQlVHIGZsYWcgaW4gdHNjb25maWcuYnpsIHVuZGVyIHJ1bGVzX3R5cGVzY3JpcHQnKTtcbiAgICB9XG4gICAgaWYgKG9wdGlvbnMucm9vdERpciB8fCBvcHRpb25zLmJhc2VVcmwpIHtcbiAgICAgIG92ZXJyaWRlV2FybmluZ3MucHVzaChcbiAgICAgICAgICAnY29tcGlsZXJPcHRpb25zLnJvb3REaXIgYW5kIGNvbXBpbGVyT3B0aW9ucy5iYXNlVXJsIGFyZSBhbHdheXMgdGhlIHdvcmtzcGFjZSByb290IGRpcmVjdG9yeScpO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy5wcmVzZXJ2ZUNvbnN0RW51bXMpIHtcbiAgICAgIG92ZXJyaWRlV2FybmluZ3MucHVzaChcbiAgICAgICAgICAnY29tcGlsZXJPcHRpb25zLnByZXNlcnZlQ29uc3RFbnVtcyBpcyBhbHdheXMgZmFsc2UgdW5kZXIgQmF6ZWwnKTtcbiAgICB9XG4gICAgaWYgKG9wdGlvbnMubm9FbWl0T25FcnJvcikge1xuICAgICAgLy8gVE9ETyhhbGV4ZWFnbGUpOiB3aHk/P1xuICAgICAgb3ZlcnJpZGVXYXJuaW5ncy5wdXNoKFxuICAgICAgICAgICdjb21waWxlck9wdGlvbnMubm9FbWl0T25FcnJvciBpcyBhbHdheXMgZmFsc2UgdW5kZXIgQmF6ZWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKG92ZXJyaWRlV2FybmluZ3MubGVuZ3RoKSB7XG4gICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgJ1xcbldBUk5JTkc6IHlvdXIgdHNjb25maWcuanNvbiBmaWxlIHNwZWNpZmllcyBvcHRpb25zIHdoaWNoIGFyZSBvdmVycmlkZGVuIGJ5IEJhemVsOicpO1xuICAgIGZvciAoY29uc3QgdyBvZiBvdmVycmlkZVdhcm5pbmdzKSBjb25zb2xlLmVycm9yKGAgLSAke3d9YCk7XG4gICAgY29uc29sZS5lcnJvcignXFxuJyk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgc2FtZSBhcyBOb2RlJ3MgcGF0aC5yZXNvbHZlLCBob3dldmVyIGl0IHJldHVybnMgYSBwYXRoIHdpdGggZm9yd2FyZFxuICogc2xhc2hlcyByYXRoZXIgdGhhbiBqb2luaW5nIHRoZSByZXNvbHZlZCBwYXRoIHdpdGggdGhlIHBsYXRmb3JtJ3MgcGF0aFxuICogc2VwYXJhdG9yLlxuICogTm90ZSB0aGF0IGV2ZW4gcGF0aC5wb3NpeC5yZXNvbHZlKCcuJykgcmV0dXJucyBDOlxcVXNlcnNcXC4uLiB3aXRoIGJhY2tzbGFzaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU5vcm1hbGl6ZWRQYXRoKC4uLnNlZ21lbnRzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLnJlc29sdmUoLi4uc2VnbWVudHMpLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcbn1cblxuLyoqXG4gKiBMb2FkIGEgdHNjb25maWcuanNvbiBhbmQgY29udmVydCBhbGwgcmVmZXJlbmNlZCBwYXRocyAoaW5jbHVkaW5nXG4gKiBiYXplbE9wdGlvbnMpIHRvIGFic29sdXRlIHBhdGhzLlxuICogUGF0aHMgc2VlbiBieSBUeXBlU2NyaXB0IHNob3VsZCBiZSBhYnNvbHV0ZSwgdG8gbWF0Y2ggYmVoYXZpb3JcbiAqIG9mIHRoZSB0c2MgTW9kdWxlUmVzb2x1dGlvbiBpbXBsZW1lbnRhdGlvbi5cbiAqIEBwYXJhbSB0c2NvbmZpZ0ZpbGUgcGF0aCB0byB0c2NvbmZpZywgcmVsYXRpdmUgdG8gcHJvY2Vzcy5jd2QoKSBvciBhYnNvbHV0ZVxuICogQHJldHVybiBjb25maWd1cmF0aW9uIHBhcnNlZCBmcm9tIHRoZSBmaWxlLCBvciBlcnJvciBkaWFnbm9zdGljc1xuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUc2NvbmZpZyhcbiAgICB0c2NvbmZpZ0ZpbGU6IHN0cmluZywgaG9zdDogdHMuUGFyc2VDb25maWdIb3N0ID0gdHMuc3lzKTpcbiAgICBbUGFyc2VkVHNDb25maWd8bnVsbCwgdHMuRGlhZ25vc3RpY1tdfG51bGwsIHt0YXJnZXQ6IHN0cmluZ31dIHtcbiAgLy8gVHlwZVNjcmlwdCBleHBlY3RzIGFuIGFic29sdXRlIHBhdGggZm9yIHRoZSB0c2NvbmZpZy5qc29uIGZpbGVcbiAgdHNjb25maWdGaWxlID0gcmVzb2x2ZU5vcm1hbGl6ZWRQYXRoKHRzY29uZmlnRmlsZSk7XG5cbiAgY29uc3QgaXNVbmRlZmluZWQgPSAodmFsdWU6IGFueSk6IHZhbHVlIGlzIHVuZGVmaW5lZCA9PiB2YWx1ZSA9PT0gdW5kZWZpbmVkO1xuXG4gIC8vIEhhbmRsZSBiYXplbCBzcGVjaWZpYyBvcHRpb25zLCBidXQgbWFrZSBzdXJlIG5vdCB0byBjcmFzaCB3aGVuIHJlYWRpbmcgYVxuICAvLyB2YW5pbGxhIHRzY29uZmlnLmpzb24uXG5cbiAgY29uc3QgcmVhZEV4dGVuZGVkQ29uZmlnRmlsZSA9XG4gICAgKGNvbmZpZ0ZpbGU6IHN0cmluZywgZXhpc3RpbmdDb25maWc/OiBhbnkpOiB7Y29uZmlnPzogYW55LCBlcnJvcj86IHRzLkRpYWdub3N0aWN9ID0+IHtcbiAgICAgIGNvbnN0IHtjb25maWcsIGVycm9yfSA9IHRzLnJlYWRDb25maWdGaWxlKGNvbmZpZ0ZpbGUsIGhvc3QucmVhZEZpbGUpO1xuXG4gICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtlcnJvcn07XG4gICAgICB9XG5cbiAgICAgIC8vIEFsbG93IEJhemVsIHVzZXJzIHRvIGNvbnRyb2wgc29tZSBvZiB0aGUgYmF6ZWwgb3B0aW9ucy5cbiAgICAgIC8vIFNpbmNlIFR5cGVTY3JpcHQncyBcImV4dGVuZHNcIiBtZWNoYW5pc20gYXBwbGllcyBvbmx5IHRvIFwiY29tcGlsZXJPcHRpb25zXCJcbiAgICAgIC8vIHdlIGhhdmUgdG8gcmVwZWF0IHNvbWUgb2YgdGhlaXIgbG9naWMgdG8gZ2V0IHRoZSB1c2VyJ3MgYmF6ZWxPcHRpb25zLlxuICAgICAgY29uc3QgbWVyZ2VkQ29uZmlnID0gZXhpc3RpbmdDb25maWcgfHwgY29uZmlnO1xuXG4gICAgICBpZiAoZXhpc3RpbmdDb25maWcpIHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmdCYXplbE9wdHM6IEJhemVsT3B0aW9ucyA9IGV4aXN0aW5nQ29uZmlnLmJhemVsT3B0aW9ucyB8fCB7fTtcbiAgICAgICAgY29uc3QgbmV3QmF6ZWxCYXplbE9wdHM6IEJhemVsT3B0aW9ucyA9IGNvbmZpZy5iYXplbE9wdGlvbnMgfHwge307XG5cbiAgICAgICAgbWVyZ2VkQ29uZmlnLmJhemVsT3B0aW9ucyA9IHtcbiAgICAgICAgICAuLi5leGlzdGluZ0JhemVsT3B0cyxcblxuICAgICAgICAgIGRpc2FibGVTdHJpY3REZXBzOiBpc1VuZGVmaW5lZChleGlzdGluZ0JhemVsT3B0cy5kaXNhYmxlU3RyaWN0RGVwcylcbiAgICAgICAgICAgID8gbmV3QmF6ZWxCYXplbE9wdHMuZGlzYWJsZVN0cmljdERlcHNcbiAgICAgICAgICAgIDogZXhpc3RpbmdCYXplbE9wdHMuZGlzYWJsZVN0cmljdERlcHMsXG5cbiAgICAgICAgICBzdXBwcmVzc1RzY29uZmlnT3ZlcnJpZGVXYXJuaW5nczogaXNVbmRlZmluZWQoZXhpc3RpbmdCYXplbE9wdHMuc3VwcHJlc3NUc2NvbmZpZ092ZXJyaWRlV2FybmluZ3MpXG4gICAgICAgICAgICA/IG5ld0JhemVsQmF6ZWxPcHRzLnN1cHByZXNzVHNjb25maWdPdmVycmlkZVdhcm5pbmdzXG4gICAgICAgICAgICA6IGV4aXN0aW5nQmF6ZWxPcHRzLnN1cHByZXNzVHNjb25maWdPdmVycmlkZVdhcm5pbmdzLFxuXG4gICAgICAgICAgdHNpY2tsZTogaXNVbmRlZmluZWQoZXhpc3RpbmdCYXplbE9wdHMudHNpY2tsZSlcbiAgICAgICAgICAgID8gbmV3QmF6ZWxCYXplbE9wdHMudHNpY2tsZVxuICAgICAgICAgICAgOiBleGlzdGluZ0JhemVsT3B0cy50c2lja2xlLFxuXG4gICAgICAgICAgZ29vZ21vZHVsZTogaXNVbmRlZmluZWQoZXhpc3RpbmdCYXplbE9wdHMuZ29vZ21vZHVsZSlcbiAgICAgICAgICAgID8gbmV3QmF6ZWxCYXplbE9wdHMuZ29vZ21vZHVsZVxuICAgICAgICAgICAgOiBleGlzdGluZ0JhemVsT3B0cy5nb29nbW9kdWxlLFxuXG4gICAgICAgICAgZGV2bW9kZVRhcmdldE92ZXJyaWRlOiBpc1VuZGVmaW5lZChleGlzdGluZ0JhemVsT3B0cy5kZXZtb2RlVGFyZ2V0T3ZlcnJpZGUpXG4gICAgICAgICAgICA/IG5ld0JhemVsQmF6ZWxPcHRzLmRldm1vZGVUYXJnZXRPdmVycmlkZVxuICAgICAgICAgICAgOiBleGlzdGluZ0JhemVsT3B0cy5kZXZtb2RlVGFyZ2V0T3ZlcnJpZGUsXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIW1lcmdlZENvbmZpZy5iYXplbE9wdGlvbnMuc3VwcHJlc3NUc2NvbmZpZ092ZXJyaWRlV2FybmluZ3MpIHtcbiAgICAgICAgICB3YXJuT25PdmVycmlkZGVuT3B0aW9ucyhjb25maWcpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChjb25maWcuZXh0ZW5kcykge1xuICAgICAgICBsZXQgZXh0ZW5kZWRDb25maWdQYXRoID0gcmVzb2x2ZU5vcm1hbGl6ZWRQYXRoKHBhdGguZGlybmFtZShjb25maWdGaWxlKSwgY29uZmlnLmV4dGVuZHMpO1xuICAgICAgICBpZiAoIWV4dGVuZGVkQ29uZmlnUGF0aC5lbmRzV2l0aCgnLmpzb24nKSkgZXh0ZW5kZWRDb25maWdQYXRoICs9ICcuanNvbic7XG5cbiAgICAgICAgcmV0dXJuIHJlYWRFeHRlbmRlZENvbmZpZ0ZpbGUoZXh0ZW5kZWRDb25maWdQYXRoLCBtZXJnZWRDb25maWcpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4ge2NvbmZpZzogbWVyZ2VkQ29uZmlnfTtcbiAgICB9O1xuXG4gIGNvbnN0IHtjb25maWcsIGVycm9yfSA9IHJlYWRFeHRlbmRlZENvbmZpZ0ZpbGUodHNjb25maWdGaWxlKTtcbiAgaWYgKGVycm9yKSB7XG4gICAgLy8gdGFyZ2V0IGlzIGluIHRoZSBjb25maWcgZmlsZSB3ZSBmYWlsZWQgdG8gbG9hZC4uLlxuICAgIHJldHVybiBbbnVsbCwgW2Vycm9yXSwge3RhcmdldDogJyd9XTtcbiAgfVxuXG4gIGNvbnN0IHtvcHRpb25zLCBlcnJvcnMsIGZpbGVOYW1lc30gPVxuICAgIHRzLnBhcnNlSnNvbkNvbmZpZ0ZpbGVDb250ZW50KGNvbmZpZywgaG9zdCwgcGF0aC5kaXJuYW1lKHRzY29uZmlnRmlsZSkpO1xuXG4gIC8vIEhhbmRsZSBiYXplbCBzcGVjaWZpYyBvcHRpb25zLCBidXQgbWFrZSBzdXJlIG5vdCB0byBjcmFzaCB3aGVuIHJlYWRpbmcgYVxuICAvLyB2YW5pbGxhIHRzY29uZmlnLmpzb24uXG4gIGNvbnN0IGJhemVsT3B0czogQmF6ZWxPcHRpb25zID0gY29uZmlnLmJhemVsT3B0aW9ucyB8fCB7fTtcbiAgY29uc3QgdGFyZ2V0ID0gYmF6ZWxPcHRzLnRhcmdldDtcbiAgYmF6ZWxPcHRzLmFsbG93ZWRTdHJpY3REZXBzID0gYmF6ZWxPcHRzLmFsbG93ZWRTdHJpY3REZXBzIHx8IFtdO1xuICBiYXplbE9wdHMudHlwZUJsYWNrTGlzdFBhdGhzID0gYmF6ZWxPcHRzLnR5cGVCbGFja0xpc3RQYXRocyB8fCBbXTtcbiAgYmF6ZWxPcHRzLmNvbXBpbGF0aW9uVGFyZ2V0U3JjID0gYmF6ZWxPcHRzLmNvbXBpbGF0aW9uVGFyZ2V0U3JjIHx8IFtdO1xuXG5cbiAgaWYgKGVycm9ycyAmJiBlcnJvcnMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIFtudWxsLCBlcnJvcnMsIHt0YXJnZXR9XTtcbiAgfVxuXG4gIC8vIE92ZXJyaWRlIHRoZSBkZXZtb2RlIHRhcmdldCBpZiBkZXZtb2RlVGFyZ2V0T3ZlcnJpZGUgaXMgc2V0XG4gIGlmIChiYXplbE9wdHMuZXM1TW9kZSAmJiBiYXplbE9wdHMuZGV2bW9kZVRhcmdldE92ZXJyaWRlKSB7XG4gICAgc3dpdGNoIChiYXplbE9wdHMuZGV2bW9kZVRhcmdldE92ZXJyaWRlLnRvTG93ZXJDYXNlKCkpIHtcbiAgICAgIGNhc2UgJ2VzMyc6XG4gICAgICAgIG9wdGlvbnMudGFyZ2V0ID0gdHMuU2NyaXB0VGFyZ2V0LkVTMztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdlczUnOlxuICAgICAgICBvcHRpb25zLnRhcmdldCA9IHRzLlNjcmlwdFRhcmdldC5FUzU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZXMyMDE1JzpcbiAgICAgICAgb3B0aW9ucy50YXJnZXQgPSB0cy5TY3JpcHRUYXJnZXQuRVMyMDE1O1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2VzMjAxNic6XG4gICAgICAgIG9wdGlvbnMudGFyZ2V0ID0gdHMuU2NyaXB0VGFyZ2V0LkVTMjAxNjtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdlczIwMTcnOlxuICAgICAgICBvcHRpb25zLnRhcmdldCA9IHRzLlNjcmlwdFRhcmdldC5FUzIwMTc7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZXMyMDE4JzpcbiAgICAgICAgb3B0aW9ucy50YXJnZXQgPSB0cy5TY3JpcHRUYXJnZXQuRVMyMDE4O1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2VzbmV4dCc6XG4gICAgICAgIG9wdGlvbnMudGFyZ2V0ID0gdHMuU2NyaXB0VGFyZ2V0LkVTTmV4dDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgJ1dBUk5JTkc6IHlvdXIgdHNjb25maWcuanNvbiBmaWxlIHNwZWNpZmllcyBhbiBpbnZhbGlkIGJhemVsT3B0aW9ucy5kZXZtb2RlVGFyZ2V0T3ZlcnJpZGUgdmFsdWUgb2Y6IFxcJyR7YmF6ZWxPcHRzLmRldm1vZGVUYXJnZXRPdmVycmlkZVxcJycpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNvcnQgcm9vdERpcnMgd2l0aCBsb25nZXN0IGluY2x1ZGUgZGlyZWN0b3JpZXMgZmlyc3QuXG4gIC8vIFdoZW4gY2Fub25pY2FsaXppbmcgcGF0aHMsIHdlIGFsd2F5cyB3YW50IHRvIHN0cmlwXG4gIC8vIGB3b3Jrc3BhY2UvYmF6ZWwtYmluL2ZpbGVgIHRvIGp1c3QgYGZpbGVgLCBub3QgdG8gYGJhemVsLWJpbi9maWxlYC5cbiAgaWYgKG9wdGlvbnMucm9vdERpcnMpIG9wdGlvbnMucm9vdERpcnMuc29ydCgoYSwgYikgPT4gYi5sZW5ndGggLSBhLmxlbmd0aCk7XG5cbiAgLy8gSWYgdGhlIHVzZXIgcmVxdWVzdGVkIGdvb2cubW9kdWxlLCB3ZSBuZWVkIHRvIHByb2R1Y2UgdGhhdCBvdXRwdXQgZXZlbiBpZlxuICAvLyB0aGUgZ2VuZXJhdGVkIHRzY29uZmlnIGluZGljYXRlcyBvdGhlcndpc2UuXG4gIGlmIChiYXplbE9wdHMuZ29vZ21vZHVsZSkgb3B0aW9ucy5tb2R1bGUgPSB0cy5Nb2R1bGVLaW5kLkNvbW1vbkpTO1xuXG4gIC8vIFR5cGVTY3JpcHQncyBwYXJzZUpzb25Db25maWdGaWxlQ29udGVudCByZXR1cm5zIHBhdGhzIHRoYXQgYXJlIGpvaW5lZCwgZWcuXG4gIC8vIC9wYXRoL3RvL3Byb2plY3QvYmF6ZWwtb3V0L2FyY2gvYmluL3BhdGgvdG8vcGFja2FnZS8uLi8uLi8uLi8uLi8uLi8uLi9wYXRoXG4gIC8vIFdlIG5vcm1hbGl6ZSB0aGVtIHRvIHJlbW92ZSB0aGUgaW50ZXJtZWRpYXRlIHBhcmVudCBkaXJlY3Rvcmllcy5cbiAgLy8gVGhpcyBpbXByb3ZlcyBlcnJvciBtZXNzYWdlcyBhbmQgYWxzbyBtYXRjaGVzIGxvZ2ljIGluIHRzY193cmFwcGVkIHdoZXJlIHdlXG4gIC8vIGV4cGVjdCBub3JtYWxpemVkIHBhdGhzLlxuICBjb25zdCBmaWxlcyA9IGZpbGVOYW1lcy5tYXAoZiA9PiBwYXRoLnBvc2l4Lm5vcm1hbGl6ZShmKSk7XG5cbiAgLy8gVGhlIGJhemVsT3B0cyBwYXRocyBpbiB0aGUgdHNjb25maWcgYXJlIHJlbGF0aXZlIHRvXG4gIC8vIG9wdGlvbnMucm9vdERpciAodGhlIHdvcmtzcGFjZSByb290KSBhbmQgYXJlbid0IHRyYW5zZm9ybWVkIGJ5XG4gIC8vIHBhcnNlSnNvbkNvbmZpZ0ZpbGVDb250ZW50IChiZWNhdXNlIFR5cGVTY3JpcHQgZG9lc24ndCBrbm93XG4gIC8vIGFib3V0IHRoZW0pLiBUcmFuc2Zvcm0gdGhlbSB0byBhbHNvIGJlIGFic29sdXRlIGhlcmUuXG4gIGJhemVsT3B0cy5jb21waWxhdGlvblRhcmdldFNyYyA9IGJhemVsT3B0cy5jb21waWxhdGlvblRhcmdldFNyYy5tYXAoXG4gICAgICBmID0+IHJlc29sdmVOb3JtYWxpemVkUGF0aChvcHRpb25zLnJvb3REaXIhLCBmKSk7XG4gIGJhemVsT3B0cy5hbGxvd2VkU3RyaWN0RGVwcyA9IGJhemVsT3B0cy5hbGxvd2VkU3RyaWN0RGVwcy5tYXAoXG4gICAgICBmID0+IHJlc29sdmVOb3JtYWxpemVkUGF0aChvcHRpb25zLnJvb3REaXIhLCBmKSk7XG4gIGJhemVsT3B0cy50eXBlQmxhY2tMaXN0UGF0aHMgPSBiYXplbE9wdHMudHlwZUJsYWNrTGlzdFBhdGhzLm1hcChcbiAgICAgIGYgPT4gcmVzb2x2ZU5vcm1hbGl6ZWRQYXRoKG9wdGlvbnMucm9vdERpciEsIGYpKTtcbiAgaWYgKGJhemVsT3B0cy5ub2RlTW9kdWxlc1ByZWZpeCkge1xuICAgIGJhemVsT3B0cy5ub2RlTW9kdWxlc1ByZWZpeCA9XG4gICAgICAgIHJlc29sdmVOb3JtYWxpemVkUGF0aChvcHRpb25zLnJvb3REaXIhLCBiYXplbE9wdHMubm9kZU1vZHVsZXNQcmVmaXgpO1xuICB9XG5cbiAgbGV0IGRpc2FibGVkVHNldHNlUnVsZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcGx1Z2luQ29uZmlnIG9mIG9wdGlvbnNbJ3BsdWdpbnMnXSBhcyBQbHVnaW5JbXBvcnRXaXRoQ29uZmlnW10gfHxcbiAgICAgICBbXSkge1xuICAgIGlmIChwbHVnaW5Db25maWcubmFtZSAmJiBwbHVnaW5Db25maWcubmFtZSA9PT0gJ0BiYXplbC90c2V0c2UnKSB7XG4gICAgICBjb25zdCBkaXNhYmxlZFJ1bGVzID0gcGx1Z2luQ29uZmlnWydkaXNhYmxlZFJ1bGVzJ107XG4gICAgICBpZiAoZGlzYWJsZWRSdWxlcyAmJiAhQXJyYXkuaXNBcnJheShkaXNhYmxlZFJ1bGVzKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Rpc2FibGVkIHRzZXRzZSBydWxlcyBtdXN0IGJlIGFuIGFycmF5IG9mIHJ1bGUgbmFtZXMnKTtcbiAgICAgIH1cbiAgICAgIGRpc2FibGVkVHNldHNlUnVsZXMgPSBkaXNhYmxlZFJ1bGVzIGFzIHN0cmluZ1tdO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFtcbiAgICB7b3B0aW9ucywgYmF6ZWxPcHRzLCBmaWxlcywgY29uZmlnLCBkaXNhYmxlZFRzZXRzZVJ1bGVzfSwgbnVsbCwge3RhcmdldH1cbiAgXTtcbn1cbiJdfQ==