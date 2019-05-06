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
        define(["require", "exports", "path", "typescript", "./perf_trace", "./plugin_api"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const path = require("path");
    const ts = require("typescript");
    const perfTrace = require("./perf_trace");
    const pluginApi = require("./plugin_api");
    /** The TypeScript diagnostic code for "Cannot find module ...". */
    exports.TS_ERR_CANNOT_FIND_MODULE = 2307;
    /**
     * The strict_deps plugin checks the imports of the compiled modules.
     *
     * It implements strict deps, i.e. enforces that each file in
     * `config.compilationTargetSrc` only imports from files in
     * `config.allowedStrictDeps`.
     *
     * This is used to implement strict dependency checking -
     * source files in a build target may only import sources of their immediate
     * dependencies, but not sources of their transitive dependencies.
     *
     * strict_deps also makes sure that no imports ends in '.ts'. TypeScript
     * allows imports including the file extension, but our runtime loading support
     * fails with it.
     *
     * strict_deps currently does not check ambient/global definitions.
     */
    exports.PLUGIN = {
        wrap: (program, config) => {
            const proxy = pluginApi.createProxy(program);
            proxy.getSemanticDiagnostics = function (sourceFile) {
                const result = [...program.getSemanticDiagnostics(sourceFile)];
                perfTrace.wrap('checkModuleDeps', () => {
                    result.push(...checkModuleDeps(sourceFile, program.getTypeChecker(), config.allowedStrictDeps, config.rootDir, config.ignoredFilesPrefixes));
                });
                return result;
            };
            return proxy;
        }
    };
    // Exported for testing
    function checkModuleDeps(sf, tc, allowedDeps, rootDir, ignoredFilesPrefixes = []) {
        function stripExt(fn) {
            return fn.replace(/(\.d)?\.tsx?$/, '');
        }
        const allowedMap = {};
        for (const d of allowedDeps)
            allowedMap[stripExt(d)] = true;
        const result = [];
        for (const stmt of sf.statements) {
            if (stmt.kind !== ts.SyntaxKind.ImportDeclaration &&
                stmt.kind !== ts.SyntaxKind.ExportDeclaration) {
                continue;
            }
            const id = stmt;
            const modSpec = id.moduleSpecifier;
            if (!modSpec)
                continue; // E.g. a bare "export {x};"
            const sym = tc.getSymbolAtLocation(modSpec);
            if (!sym || !sym.declarations || sym.declarations.length < 1) {
                continue;
            }
            // Module imports can only have one declaration location.
            const declFileName = sym.declarations[0].getSourceFile().fileName;
            if (allowedMap[stripExt(declFileName)])
                continue;
            if (ignoredFilesPrefixes.some(p => declFileName.startsWith(p)))
                continue;
            const importName = path.posix.relative(rootDir, declFileName);
            result.push({
                file: sf,
                start: modSpec.getStart(),
                length: modSpec.getEnd() - modSpec.getStart(),
                messageText: `transitive dependency on ${importName} not allowed. ` +
                    `Please add the BUILD target to your rule's deps.`,
                category: ts.DiagnosticCategory.Error,
                // semantics are close enough, needs taze.
                code: exports.TS_ERR_CANNOT_FIND_MODULE,
            });
        }
        return result;
    }
    exports.checkModuleDeps = checkModuleDeps;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RyaWN0X2RlcHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzY193cmFwcGVkL3N0cmljdF9kZXBzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7R0FlRzs7Ozs7Ozs7Ozs7O0lBRUgsNkJBQTZCO0lBQzdCLGlDQUFpQztJQUVqQywwQ0FBMEM7SUFDMUMsMENBQTBDO0lBYTFDLG1FQUFtRTtJQUN0RCxRQUFBLHlCQUF5QixHQUFHLElBQUksQ0FBQztJQUU5Qzs7Ozs7Ozs7Ozs7Ozs7OztPQWdCRztJQUNVLFFBQUEsTUFBTSxHQUFxQjtRQUN0QyxJQUFJLEVBQUUsQ0FBQyxPQUFtQixFQUFFLE1BQThCLEVBQWMsRUFBRTtZQUN4RSxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQzdDLEtBQUssQ0FBQyxzQkFBc0IsR0FBRyxVQUFTLFVBQXlCO2dCQUMvRCxNQUFNLE1BQU0sR0FBRyxDQUFDLEdBQUcsT0FBTyxDQUFDLHNCQUFzQixDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7Z0JBQy9ELFNBQVMsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO29CQUNyQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsZUFBZSxDQUMxQixVQUFVLEVBQUUsT0FBTyxDQUFDLGNBQWMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxpQkFBaUIsRUFDOUQsTUFBTSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDO2dCQUNwRCxDQUFDLENBQUMsQ0FBQztnQkFDSCxPQUFPLE1BQU0sQ0FBQztZQUNoQixDQUFDLENBQUM7WUFDRixPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7S0FDRixDQUFDO0lBRUYsdUJBQXVCO0lBQ3ZCLFNBQWdCLGVBQWUsQ0FDM0IsRUFBaUIsRUFBRSxFQUFrQixFQUFFLFdBQXFCLEVBQzVELE9BQWUsRUFBRSx1QkFBaUMsRUFBRTtRQUN0RCxTQUFTLFFBQVEsQ0FBQyxFQUFVO1lBQzFCLE9BQU8sRUFBRSxDQUFDLE9BQU8sQ0FBQyxlQUFlLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDekMsQ0FBQztRQUNELE1BQU0sVUFBVSxHQUFrQyxFQUFFLENBQUM7UUFDckQsS0FBSyxNQUFNLENBQUMsSUFBSSxXQUFXO1lBQUUsVUFBVSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQztRQUU1RCxNQUFNLE1BQU0sR0FBb0IsRUFBRSxDQUFDO1FBQ25DLEtBQUssTUFBTSxJQUFJLElBQUksRUFBRSxDQUFDLFVBQVUsRUFBRTtZQUNoQyxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDLFVBQVUsQ0FBQyxpQkFBaUI7Z0JBQzdDLElBQUksQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDLFVBQVUsQ0FBQyxpQkFBaUIsRUFBRTtnQkFDakQsU0FBUzthQUNWO1lBQ0QsTUFBTSxFQUFFLEdBQUcsSUFBbUQsQ0FBQztZQUMvRCxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUMsZUFBZSxDQUFDO1lBQ25DLElBQUksQ0FBQyxPQUFPO2dCQUFFLFNBQVMsQ0FBRSw0QkFBNEI7WUFFckQsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQzVDLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLEdBQUcsQ0FBQyxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtnQkFDNUQsU0FBUzthQUNWO1lBQ0QseURBQXlEO1lBQ3pELE1BQU0sWUFBWSxHQUFHLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxFQUFFLENBQUMsUUFBUSxDQUFDO1lBQ2xFLElBQUksVUFBVSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQztnQkFBRSxTQUFTO1lBQ2pELElBQUksb0JBQW9CLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFBRSxTQUFTO1lBQ3pFLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLE9BQU8sRUFBRSxZQUFZLENBQUMsQ0FBQztZQUM5RCxNQUFNLENBQUMsSUFBSSxDQUFDO2dCQUNWLElBQUksRUFBRSxFQUFFO2dCQUNSLEtBQUssRUFBRSxPQUFPLENBQUMsUUFBUSxFQUFFO2dCQUN6QixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxRQUFRLEVBQUU7Z0JBQzdDLFdBQVcsRUFBRSw0QkFBNEIsVUFBVSxnQkFBZ0I7b0JBQy9ELGtEQUFrRDtnQkFDdEQsUUFBUSxFQUFFLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLO2dCQUNyQywwQ0FBMEM7Z0JBQzFDLElBQUksRUFBRSxpQ0FBeUI7YUFDaEMsQ0FBQyxDQUFDO1NBQ0o7UUFDRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBeENELDBDQXdDQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGxpY2Vuc2VcbiAqIENvcHlyaWdodCAyMDE3IFRoZSBCYXplbCBBdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLlxuICpcbiAqIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gKiB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gKlxuICogWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG4gKiAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgdHMgZnJvbSAndHlwZXNjcmlwdCc7XG5cbmltcG9ydCAqIGFzIHBlcmZUcmFjZSBmcm9tICcuL3BlcmZfdHJhY2UnO1xuaW1wb3J0ICogYXMgcGx1Z2luQXBpIGZyb20gJy4vcGx1Z2luX2FwaSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RyaWN0RGVwc1BsdWdpbkNvbmZpZyB7XG4gIGNvbXBpbGF0aW9uVGFyZ2V0U3JjOiBzdHJpbmdbXTtcbiAgYWxsb3dlZFN0cmljdERlcHM6IHN0cmluZ1tdO1xuICByb290RGlyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBQYXRocyB3aGVyZSB1c2VycyBtYXkgZnJlZWx5IGltcG9ydCB3aXRob3V0IGRlY2xhcmVkIGRlcGVuZGVuY2llcy5cbiAgICogVGhpcyBpcyB1c2VkIGluIEJhemVsIHdoZXJlIGRlcGVuZGVuY2llcyBvbiBub2RlX21vZHVsZXMgbWF5IGJlIHVuZGVjbGFyZWQuXG4gICAqL1xuICBpZ25vcmVkRmlsZXNQcmVmaXhlcz86IHN0cmluZ1tdO1xufVxuXG4vKiogVGhlIFR5cGVTY3JpcHQgZGlhZ25vc3RpYyBjb2RlIGZvciBcIkNhbm5vdCBmaW5kIG1vZHVsZSAuLi5cIi4gKi9cbmV4cG9ydCBjb25zdCBUU19FUlJfQ0FOTk9UX0ZJTkRfTU9EVUxFID0gMjMwNztcblxuLyoqXG4gKiBUaGUgc3RyaWN0X2RlcHMgcGx1Z2luIGNoZWNrcyB0aGUgaW1wb3J0cyBvZiB0aGUgY29tcGlsZWQgbW9kdWxlcy5cbiAqXG4gKiBJdCBpbXBsZW1lbnRzIHN0cmljdCBkZXBzLCBpLmUuIGVuZm9yY2VzIHRoYXQgZWFjaCBmaWxlIGluXG4gKiBgY29uZmlnLmNvbXBpbGF0aW9uVGFyZ2V0U3JjYCBvbmx5IGltcG9ydHMgZnJvbSBmaWxlcyBpblxuICogYGNvbmZpZy5hbGxvd2VkU3RyaWN0RGVwc2AuXG4gKlxuICogVGhpcyBpcyB1c2VkIHRvIGltcGxlbWVudCBzdHJpY3QgZGVwZW5kZW5jeSBjaGVja2luZyAtXG4gKiBzb3VyY2UgZmlsZXMgaW4gYSBidWlsZCB0YXJnZXQgbWF5IG9ubHkgaW1wb3J0IHNvdXJjZXMgb2YgdGhlaXIgaW1tZWRpYXRlXG4gKiBkZXBlbmRlbmNpZXMsIGJ1dCBub3Qgc291cmNlcyBvZiB0aGVpciB0cmFuc2l0aXZlIGRlcGVuZGVuY2llcy5cbiAqXG4gKiBzdHJpY3RfZGVwcyBhbHNvIG1ha2VzIHN1cmUgdGhhdCBubyBpbXBvcnRzIGVuZHMgaW4gJy50cycuIFR5cGVTY3JpcHRcbiAqIGFsbG93cyBpbXBvcnRzIGluY2x1ZGluZyB0aGUgZmlsZSBleHRlbnNpb24sIGJ1dCBvdXIgcnVudGltZSBsb2FkaW5nIHN1cHBvcnRcbiAqIGZhaWxzIHdpdGggaXQuXG4gKlxuICogc3RyaWN0X2RlcHMgY3VycmVudGx5IGRvZXMgbm90IGNoZWNrIGFtYmllbnQvZ2xvYmFsIGRlZmluaXRpb25zLlxuICovXG5leHBvcnQgY29uc3QgUExVR0lOOiBwbHVnaW5BcGkuUGx1Z2luID0ge1xuICB3cmFwOiAocHJvZ3JhbTogdHMuUHJvZ3JhbSwgY29uZmlnOiBTdHJpY3REZXBzUGx1Z2luQ29uZmlnKTogdHMuUHJvZ3JhbSA9PiB7XG4gICAgY29uc3QgcHJveHkgPSBwbHVnaW5BcGkuY3JlYXRlUHJveHkocHJvZ3JhbSk7XG4gICAgcHJveHkuZ2V0U2VtYW50aWNEaWFnbm9zdGljcyA9IGZ1bmN0aW9uKHNvdXJjZUZpbGU6IHRzLlNvdXJjZUZpbGUpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IFsuLi5wcm9ncmFtLmdldFNlbWFudGljRGlhZ25vc3RpY3Moc291cmNlRmlsZSldO1xuICAgICAgcGVyZlRyYWNlLndyYXAoJ2NoZWNrTW9kdWxlRGVwcycsICgpID0+IHtcbiAgICAgICAgcmVzdWx0LnB1c2goLi4uY2hlY2tNb2R1bGVEZXBzKFxuICAgICAgICAgICAgc291cmNlRmlsZSwgcHJvZ3JhbS5nZXRUeXBlQ2hlY2tlcigpLCBjb25maWcuYWxsb3dlZFN0cmljdERlcHMsXG4gICAgICAgICAgICBjb25maWcucm9vdERpciwgY29uZmlnLmlnbm9yZWRGaWxlc1ByZWZpeGVzKSk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgICByZXR1cm4gcHJveHk7XG4gIH1cbn07XG5cbi8vIEV4cG9ydGVkIGZvciB0ZXN0aW5nXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tNb2R1bGVEZXBzKFxuICAgIHNmOiB0cy5Tb3VyY2VGaWxlLCB0YzogdHMuVHlwZUNoZWNrZXIsIGFsbG93ZWREZXBzOiBzdHJpbmdbXSxcbiAgICByb290RGlyOiBzdHJpbmcsIGlnbm9yZWRGaWxlc1ByZWZpeGVzOiBzdHJpbmdbXSA9IFtdKTogdHMuRGlhZ25vc3RpY1tdIHtcbiAgZnVuY3Rpb24gc3RyaXBFeHQoZm46IHN0cmluZykge1xuICAgIHJldHVybiBmbi5yZXBsYWNlKC8oXFwuZCk/XFwudHN4PyQvLCAnJyk7XG4gIH1cbiAgY29uc3QgYWxsb3dlZE1hcDoge1tmaWxlTmFtZTogc3RyaW5nXTogYm9vbGVhbn0gPSB7fTtcbiAgZm9yIChjb25zdCBkIG9mIGFsbG93ZWREZXBzKSBhbGxvd2VkTWFwW3N0cmlwRXh0KGQpXSA9IHRydWU7XG5cbiAgY29uc3QgcmVzdWx0OiB0cy5EaWFnbm9zdGljW10gPSBbXTtcbiAgZm9yIChjb25zdCBzdG10IG9mIHNmLnN0YXRlbWVudHMpIHtcbiAgICBpZiAoc3RtdC5raW5kICE9PSB0cy5TeW50YXhLaW5kLkltcG9ydERlY2xhcmF0aW9uICYmXG4gICAgICAgIHN0bXQua2luZCAhPT0gdHMuU3ludGF4S2luZC5FeHBvcnREZWNsYXJhdGlvbikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gc3RtdCBhcyB0cy5JbXBvcnREZWNsYXJhdGlvbiB8IHRzLkV4cG9ydERlY2xhcmF0aW9uO1xuICAgIGNvbnN0IG1vZFNwZWMgPSBpZC5tb2R1bGVTcGVjaWZpZXI7XG4gICAgaWYgKCFtb2RTcGVjKSBjb250aW51ZTsgIC8vIEUuZy4gYSBiYXJlIFwiZXhwb3J0IHt4fTtcIlxuXG4gICAgY29uc3Qgc3ltID0gdGMuZ2V0U3ltYm9sQXRMb2NhdGlvbihtb2RTcGVjKTtcbiAgICBpZiAoIXN5bSB8fCAhc3ltLmRlY2xhcmF0aW9ucyB8fCBzeW0uZGVjbGFyYXRpb25zLmxlbmd0aCA8IDEpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBNb2R1bGUgaW1wb3J0cyBjYW4gb25seSBoYXZlIG9uZSBkZWNsYXJhdGlvbiBsb2NhdGlvbi5cbiAgICBjb25zdCBkZWNsRmlsZU5hbWUgPSBzeW0uZGVjbGFyYXRpb25zWzBdLmdldFNvdXJjZUZpbGUoKS5maWxlTmFtZTtcbiAgICBpZiAoYWxsb3dlZE1hcFtzdHJpcEV4dChkZWNsRmlsZU5hbWUpXSkgY29udGludWU7XG4gICAgaWYgKGlnbm9yZWRGaWxlc1ByZWZpeGVzLnNvbWUocCA9PiBkZWNsRmlsZU5hbWUuc3RhcnRzV2l0aChwKSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGltcG9ydE5hbWUgPSBwYXRoLnBvc2l4LnJlbGF0aXZlKHJvb3REaXIsIGRlY2xGaWxlTmFtZSk7XG4gICAgcmVzdWx0LnB1c2goe1xuICAgICAgZmlsZTogc2YsXG4gICAgICBzdGFydDogbW9kU3BlYy5nZXRTdGFydCgpLFxuICAgICAgbGVuZ3RoOiBtb2RTcGVjLmdldEVuZCgpIC0gbW9kU3BlYy5nZXRTdGFydCgpLFxuICAgICAgbWVzc2FnZVRleHQ6IGB0cmFuc2l0aXZlIGRlcGVuZGVuY3kgb24gJHtpbXBvcnROYW1lfSBub3QgYWxsb3dlZC4gYCArXG4gICAgICAgICAgYFBsZWFzZSBhZGQgdGhlIEJVSUxEIHRhcmdldCB0byB5b3VyIHJ1bGUncyBkZXBzLmAsXG4gICAgICBjYXRlZ29yeTogdHMuRGlhZ25vc3RpY0NhdGVnb3J5LkVycm9yLFxuICAgICAgLy8gc2VtYW50aWNzIGFyZSBjbG9zZSBlbm91Z2gsIG5lZWRzIHRhemUuXG4gICAgICBjb2RlOiBUU19FUlJfQ0FOTk9UX0ZJTkRfTU9EVUxFLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG4iXX0=