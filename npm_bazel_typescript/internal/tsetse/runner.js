/**
 * @fileoverview Runner is the entry point of running Tsetse checks in compiler.
 */
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "../tsc_wrapped/perf_trace", "../tsc_wrapped/plugin_api", "./checker", "./rules/ban_expect_truthy_promise_rule", "./rules/ban_promise_as_condition_rule", "./rules/check_return_value_rule", "./rules/equals_nan_rule", "./rules/must_use_promises_rule"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const perfTrace = require("../tsc_wrapped/perf_trace");
    const pluginApi = require("../tsc_wrapped/plugin_api");
    const checker_1 = require("./checker");
    const ban_expect_truthy_promise_rule_1 = require("./rules/ban_expect_truthy_promise_rule");
    const ban_promise_as_condition_rule_1 = require("./rules/ban_promise_as_condition_rule");
    const check_return_value_rule_1 = require("./rules/check_return_value_rule");
    const equals_nan_rule_1 = require("./rules/equals_nan_rule");
    const must_use_promises_rule_1 = require("./rules/must_use_promises_rule");
    /**
     * List of Tsetse rules. Shared between the program plugin and the language
     * service plugin.
     */
    const ENABLED_RULES = [
        new check_return_value_rule_1.Rule(),
        new equals_nan_rule_1.Rule(),
        new ban_expect_truthy_promise_rule_1.Rule(),
        new must_use_promises_rule_1.Rule(),
        new ban_promise_as_condition_rule_1.Rule(),
    ];
    /**
     * The Tsetse check plugin performs compile-time static analysis for TypeScript
     * code.
     */
    exports.PLUGIN = {
        wrap(program, disabledTsetseRules = []) {
            const checker = new checker_1.Checker(program);
            registerRules(checker, disabledTsetseRules);
            const proxy = pluginApi.createProxy(program);
            proxy.getSemanticDiagnostics = (sourceFile) => {
                const result = [...program.getSemanticDiagnostics(sourceFile)];
                perfTrace.wrap('checkConformance', () => {
                    result.push(...checker.execute(sourceFile)
                        .map(failure => failure.toDiagnostic()));
                });
                return result;
            };
            return proxy;
        },
    };
    function registerRules(checker, disabledTsetseRules) {
        for (const rule of ENABLED_RULES) {
            if (disabledTsetseRules.indexOf(rule.ruleName) === -1) {
                rule.register(checker);
            }
        }
    }
    exports.registerRules = registerRules;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVubmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vZXh0ZXJuYWwvYnVpbGRfYmF6ZWxfcnVsZXNfdHlwZXNjcmlwdC9pbnRlcm5hbC90c2V0c2UvcnVubmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOztHQUVHOzs7Ozs7Ozs7Ozs7SUFJSCx1REFBdUQ7SUFDdkQsdURBQXVEO0lBRXZELHVDQUFrQztJQUVsQywyRkFBMEY7SUFDMUYseUZBQXdGO0lBQ3hGLDZFQUE2RTtJQUM3RSw2REFBOEQ7SUFDOUQsMkVBQTJFO0lBRTNFOzs7T0FHRztJQUNILE1BQU0sYUFBYSxHQUFtQjtRQUNwQyxJQUFJLDhCQUFvQixFQUFFO1FBQzFCLElBQUksc0JBQWEsRUFBRTtRQUNuQixJQUFJLHFDQUEwQixFQUFFO1FBQ2hDLElBQUksNkJBQW1CLEVBQUU7UUFDekIsSUFBSSxvQ0FBeUIsRUFBRTtLQUNoQyxDQUFDO0lBRUY7OztPQUdHO0lBQ1UsUUFBQSxNQUFNLEdBQXFCO1FBQ3RDLElBQUksQ0FBQyxPQUFtQixFQUFFLHNCQUFnQyxFQUFFO1lBQzFELE1BQU0sT0FBTyxHQUFHLElBQUksaUJBQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUNyQyxhQUFhLENBQUMsT0FBTyxFQUFFLG1CQUFtQixDQUFDLENBQUM7WUFDNUMsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUM3QyxLQUFLLENBQUMsc0JBQXNCLEdBQUcsQ0FBQyxVQUF5QixFQUFFLEVBQUU7Z0JBQzNELE1BQU0sTUFBTSxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztnQkFDL0QsU0FBUyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7b0JBQ3RDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQzt5QkFDekIsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQztnQkFDM0QsQ0FBQyxDQUFDLENBQUM7Z0JBQ0gsT0FBTyxNQUFNLENBQUM7WUFDaEIsQ0FBQyxDQUFDO1lBQ0YsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO0tBQ0YsQ0FBQztJQUVGLFNBQWdCLGFBQWEsQ0FBQyxPQUFnQixFQUFFLG1CQUE2QjtRQUMzRSxLQUFLLE1BQU0sSUFBSSxJQUFJLGFBQWEsRUFBRTtZQUNoQyxJQUFJLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUU7Z0JBQ3JELElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUM7YUFDeEI7U0FDRjtJQUNILENBQUM7SUFORCxzQ0FNQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGZpbGVvdmVydmlldyBSdW5uZXIgaXMgdGhlIGVudHJ5IHBvaW50IG9mIHJ1bm5pbmcgVHNldHNlIGNoZWNrcyBpbiBjb21waWxlci5cbiAqL1xuXG5pbXBvcnQgKiBhcyB0cyBmcm9tICd0eXBlc2NyaXB0JztcblxuaW1wb3J0ICogYXMgcGVyZlRyYWNlIGZyb20gJy4uL3RzY193cmFwcGVkL3BlcmZfdHJhY2UnO1xuaW1wb3J0ICogYXMgcGx1Z2luQXBpIGZyb20gJy4uL3RzY193cmFwcGVkL3BsdWdpbl9hcGknO1xuXG5pbXBvcnQge0NoZWNrZXJ9IGZyb20gJy4vY2hlY2tlcic7XG5pbXBvcnQge0Fic3RyYWN0UnVsZX0gZnJvbSAnLi9ydWxlJztcbmltcG9ydCB7UnVsZSBhcyBCYW5FeHBlY3RUcnV0aHlQcm9taXNlUnVsZX0gZnJvbSAnLi9ydWxlcy9iYW5fZXhwZWN0X3RydXRoeV9wcm9taXNlX3J1bGUnO1xuaW1wb3J0IHtSdWxlIGFzIEJhblByb21pc2VBc0NvbmRpdGlvblJ1bGV9IGZyb20gJy4vcnVsZXMvYmFuX3Byb21pc2VfYXNfY29uZGl0aW9uX3J1bGUnO1xuaW1wb3J0IHtSdWxlIGFzIENoZWNrUmV0dXJuVmFsdWVSdWxlfSBmcm9tICcuL3J1bGVzL2NoZWNrX3JldHVybl92YWx1ZV9ydWxlJztcbmltcG9ydCB7UnVsZSBhcyBFcXVhbHNOYW5SdWxlfSBmcm9tICcuL3J1bGVzL2VxdWFsc19uYW5fcnVsZSc7XG5pbXBvcnQge1J1bGUgYXMgTXVzdFVzZVByb21pc2VzUnVsZX0gZnJvbSAnLi9ydWxlcy9tdXN0X3VzZV9wcm9taXNlc19ydWxlJztcblxuLyoqXG4gKiBMaXN0IG9mIFRzZXRzZSBydWxlcy4gU2hhcmVkIGJldHdlZW4gdGhlIHByb2dyYW0gcGx1Z2luIGFuZCB0aGUgbGFuZ3VhZ2VcbiAqIHNlcnZpY2UgcGx1Z2luLlxuICovXG5jb25zdCBFTkFCTEVEX1JVTEVTOiBBYnN0cmFjdFJ1bGVbXSA9IFtcbiAgbmV3IENoZWNrUmV0dXJuVmFsdWVSdWxlKCksXG4gIG5ldyBFcXVhbHNOYW5SdWxlKCksXG4gIG5ldyBCYW5FeHBlY3RUcnV0aHlQcm9taXNlUnVsZSgpLFxuICBuZXcgTXVzdFVzZVByb21pc2VzUnVsZSgpLFxuICBuZXcgQmFuUHJvbWlzZUFzQ29uZGl0aW9uUnVsZSgpLFxuXTtcblxuLyoqXG4gKiBUaGUgVHNldHNlIGNoZWNrIHBsdWdpbiBwZXJmb3JtcyBjb21waWxlLXRpbWUgc3RhdGljIGFuYWx5c2lzIGZvciBUeXBlU2NyaXB0XG4gKiBjb2RlLlxuICovXG5leHBvcnQgY29uc3QgUExVR0lOOiBwbHVnaW5BcGkuUGx1Z2luID0ge1xuICB3cmFwKHByb2dyYW06IHRzLlByb2dyYW0sIGRpc2FibGVkVHNldHNlUnVsZXM6IHN0cmluZ1tdID0gW10pOiB0cy5Qcm9ncmFtIHtcbiAgICBjb25zdCBjaGVja2VyID0gbmV3IENoZWNrZXIocHJvZ3JhbSk7XG4gICAgcmVnaXN0ZXJSdWxlcyhjaGVja2VyLCBkaXNhYmxlZFRzZXRzZVJ1bGVzKTtcbiAgICBjb25zdCBwcm94eSA9IHBsdWdpbkFwaS5jcmVhdGVQcm94eShwcm9ncmFtKTtcbiAgICBwcm94eS5nZXRTZW1hbnRpY0RpYWdub3N0aWNzID0gKHNvdXJjZUZpbGU6IHRzLlNvdXJjZUZpbGUpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IFsuLi5wcm9ncmFtLmdldFNlbWFudGljRGlhZ25vc3RpY3Moc291cmNlRmlsZSldO1xuICAgICAgcGVyZlRyYWNlLndyYXAoJ2NoZWNrQ29uZm9ybWFuY2UnLCAoKSA9PiB7XG4gICAgICAgIHJlc3VsdC5wdXNoKC4uLmNoZWNrZXIuZXhlY3V0ZShzb3VyY2VGaWxlKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcChmYWlsdXJlID0+IGZhaWx1cmUudG9EaWFnbm9zdGljKCkpKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICAgIHJldHVybiBwcm94eTtcbiAgfSxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclJ1bGVzKGNoZWNrZXI6IENoZWNrZXIsIGRpc2FibGVkVHNldHNlUnVsZXM6IHN0cmluZ1tdKSB7XG4gIGZvciAoY29uc3QgcnVsZSBvZiBFTkFCTEVEX1JVTEVTKSB7XG4gICAgaWYgKGRpc2FibGVkVHNldHNlUnVsZXMuaW5kZXhPZihydWxlLnJ1bGVOYW1lKSA9PT0gLTEpIHtcbiAgICAgIHJ1bGUucmVnaXN0ZXIoY2hlY2tlcik7XG4gICAgfVxuICB9XG59XG4iXX0=