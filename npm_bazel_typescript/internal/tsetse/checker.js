/**
 * @fileoverview Checker contains all the information we need to perform source
 * file AST traversals and report errors.
 */
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "typescript", "./failure"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const ts = require("typescript");
    const failure_1 = require("./failure");
    /**
     * Tsetse rules use on() and addFailureAtNode() for rule implementations.
     * Rules can get a ts.TypeChecker from checker.typeChecker so typed rules are
     * possible. Compiler uses execute() to run the Tsetse check.
     */
    class Checker {
        constructor(program) {
            /**
             * nodeHandlersMap contains node to handlers mapping for all enabled rules.
             */
            this.nodeHandlersMap = new Map();
            this.failures = [];
            // currentCode will be set before invoking any handler functions so the value
            // initialized here is never used.
            this.currentCode = 0;
            // Avoid the cost for each rule to create a new TypeChecker.
            this.typeChecker = program.getTypeChecker();
        }
        /**
         * This doesn't run any checks yet. Instead, it registers `handlerFunction` on
         * `nodeKind` node in `nodeHandlersMap` map. After all rules register their
         * handlers, the source file AST will be traversed.
         */
        on(nodeKind, handlerFunction, code) {
            const newHandler = { handlerFunction, code };
            const registeredHandlers = this.nodeHandlersMap.get(nodeKind);
            if (registeredHandlers === undefined) {
                this.nodeHandlersMap.set(nodeKind, [newHandler]);
            }
            else {
                registeredHandlers.push(newHandler);
            }
        }
        /**
         * Add a failure with a span. addFailure() is currently private because
         * `addFailureAtNode` is preferred.
         */
        addFailure(start, end, failureText, fix) {
            if (!this.currentSourceFile) {
                throw new Error('Source file not defined');
            }
            if (start >= end || end > this.currentSourceFile.end || start < 0) {
                // Since only addFailureAtNode() is exposed for now this shouldn't happen.
                throw new Error(`Invalid start and end position: [${start}, ${end}]` +
                    ` in file ${this.currentSourceFile.fileName}.`);
            }
            const failure = new failure_1.Failure(this.currentSourceFile, start, end, failureText, this.currentCode, fix);
            this.failures.push(failure);
        }
        addFailureAtNode(node, failureText, fix) {
            // node.getStart() takes a sourceFile as argument whereas node.getEnd()
            // doesn't need it.
            this.addFailure(node.getStart(this.currentSourceFile), node.getEnd(), failureText, fix);
        }
        /**
         * Walk `sourceFile`, invoking registered handlers with Checker as the first
         * argument and current node as the second argument. Return failures if there
         * are any.
         */
        execute(sourceFile) {
            const thisChecker = this;
            this.currentSourceFile = sourceFile;
            this.failures = [];
            ts.forEachChild(sourceFile, run);
            return this.failures;
            function run(node) {
                const handlers = thisChecker.nodeHandlersMap.get(node.kind);
                if (handlers !== undefined) {
                    for (const handler of handlers) {
                        thisChecker.currentCode = handler.code;
                        handler.handlerFunction(thisChecker, node);
                    }
                }
                ts.forEachChild(node, run);
            }
        }
    }
    exports.Checker = Checker;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hlY2tlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uLy4uL2V4dGVybmFsL2J1aWxkX2JhemVsX3J1bGVzX3R5cGVzY3JpcHQvaW50ZXJuYWwvdHNldHNlL2NoZWNrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7OztHQUdHOzs7Ozs7Ozs7Ozs7SUFHSCxpQ0FBaUM7SUFDakMsdUNBQXVDO0lBWXZDOzs7O09BSUc7SUFDSCxNQUFhLE9BQU87UUFlbEIsWUFBWSxPQUFtQjtZQWQvQjs7ZUFFRztZQUNLLG9CQUFlLEdBQUcsSUFBSSxHQUFHLEVBQTRCLENBQUM7WUFDdEQsYUFBUSxHQUFjLEVBQUUsQ0FBQztZQUVqQyw2RUFBNkU7WUFDN0Usa0NBQWtDO1lBQzFCLGdCQUFXLEdBQUcsQ0FBQyxDQUFDO1lBT3RCLDREQUE0RDtZQUM1RCxJQUFJLENBQUMsV0FBVyxHQUFHLE9BQU8sQ0FBQyxjQUFjLEVBQUUsQ0FBQztRQUM5QyxDQUFDO1FBRUQ7Ozs7V0FJRztRQUNILEVBQUUsQ0FDRSxRQUFtQixFQUFFLGVBQW9ELEVBQ3pFLElBQVk7WUFDZCxNQUFNLFVBQVUsR0FBWSxFQUFDLGVBQWUsRUFBRSxJQUFJLEVBQUMsQ0FBQztZQUNwRCxNQUFNLGtCQUFrQixHQUNwQixJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN2QyxJQUFJLGtCQUFrQixLQUFLLFNBQVMsRUFBRTtnQkFDcEMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQzthQUNsRDtpQkFBTTtnQkFDTCxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7YUFDckM7UUFDSCxDQUFDO1FBRUQ7OztXQUdHO1FBQ0ssVUFBVSxDQUNkLEtBQWEsRUFBRSxHQUFXLEVBQUUsV0FBbUIsRUFBRSxHQUFTO1lBQzVELElBQUksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLEVBQUU7Z0JBQzNCLE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQzthQUM1QztZQUNELElBQUksS0FBSyxJQUFJLEdBQUcsSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFO2dCQUNqRSwwRUFBMEU7Z0JBQzFFLE1BQU0sSUFBSSxLQUFLLENBQ1gsb0NBQW9DLEtBQUssS0FBSyxHQUFHLEdBQUc7b0JBQ3BELFlBQVksSUFBSSxDQUFDLGlCQUFpQixDQUFDLFFBQVEsR0FBRyxDQUFDLENBQUM7YUFDckQ7WUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLGlCQUFPLENBQ3ZCLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLFdBQVcsRUFBRSxJQUFJLENBQUMsV0FBVyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQzVFLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzlCLENBQUM7UUFFRCxnQkFBZ0IsQ0FBQyxJQUFhLEVBQUUsV0FBbUIsRUFBRSxHQUFTO1lBQzVELHVFQUF1RTtZQUN2RSxtQkFBbUI7WUFDbkIsSUFBSSxDQUFDLFVBQVUsQ0FDWCxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxXQUFXLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDOUUsQ0FBQztRQUVEOzs7O1dBSUc7UUFDSCxPQUFPLENBQUMsVUFBeUI7WUFDL0IsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDO1lBQ3pCLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxVQUFVLENBQUM7WUFDcEMsSUFBSSxDQUFDLFFBQVEsR0FBRyxFQUFFLENBQUM7WUFDbkIsRUFBRSxDQUFDLFlBQVksQ0FBQyxVQUFVLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDakMsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDO1lBRXJCLFNBQVMsR0FBRyxDQUFDLElBQWE7Z0JBQ3hCLE1BQU0sUUFBUSxHQUNWLFdBQVcsQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDL0MsSUFBSSxRQUFRLEtBQUssU0FBUyxFQUFFO29CQUMxQixLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsRUFBRTt3QkFDOUIsV0FBVyxDQUFDLFdBQVcsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDO3dCQUN2QyxPQUFPLENBQUMsZUFBZSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsQ0FBQztxQkFDNUM7aUJBQ0Y7Z0JBQ0QsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDN0IsQ0FBQztRQUNILENBQUM7S0FDRjtJQTFGRCwwQkEwRkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBmaWxlb3ZlcnZpZXcgQ2hlY2tlciBjb250YWlucyBhbGwgdGhlIGluZm9ybWF0aW9uIHdlIG5lZWQgdG8gcGVyZm9ybSBzb3VyY2VcbiAqIGZpbGUgQVNUIHRyYXZlcnNhbHMgYW5kIHJlcG9ydCBlcnJvcnMuXG4gKi9cblxuXG5pbXBvcnQgKiBhcyB0cyBmcm9tICd0eXBlc2NyaXB0JztcbmltcG9ydCB7RmFpbHVyZSwgRml4fSBmcm9tICcuL2ZhaWx1cmUnO1xuXG5cbi8qKlxuICogQSBIYW5kbGVyIGNvbnRhaW5zIGEgaGFuZGxlciBmdW5jdGlvbiBhbmQgaXRzIGNvcnJlc3BvbmRpbmcgZXJyb3IgY29kZSBzb1xuICogd2hlbiB0aGUgaGFuZGxlciBmdW5jdGlvbiBpcyB0cmlnZ2VyZWQgd2Uga25vdyB3aGljaCBydWxlIGlzIHZpb2xhdGVkLlxuICovXG5pbnRlcmZhY2UgSGFuZGxlciB7XG4gIGhhbmRsZXJGdW5jdGlvbihjaGVja2VyOiBDaGVja2VyLCBub2RlOiB0cy5Ob2RlKTogdm9pZDtcbiAgY29kZTogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRzZXRzZSBydWxlcyB1c2Ugb24oKSBhbmQgYWRkRmFpbHVyZUF0Tm9kZSgpIGZvciBydWxlIGltcGxlbWVudGF0aW9ucy5cbiAqIFJ1bGVzIGNhbiBnZXQgYSB0cy5UeXBlQ2hlY2tlciBmcm9tIGNoZWNrZXIudHlwZUNoZWNrZXIgc28gdHlwZWQgcnVsZXMgYXJlXG4gKiBwb3NzaWJsZS4gQ29tcGlsZXIgdXNlcyBleGVjdXRlKCkgdG8gcnVuIHRoZSBUc2V0c2UgY2hlY2suXG4gKi9cbmV4cG9ydCBjbGFzcyBDaGVja2VyIHtcbiAgLyoqXG4gICAqIG5vZGVIYW5kbGVyc01hcCBjb250YWlucyBub2RlIHRvIGhhbmRsZXJzIG1hcHBpbmcgZm9yIGFsbCBlbmFibGVkIHJ1bGVzLlxuICAgKi9cbiAgcHJpdmF0ZSBub2RlSGFuZGxlcnNNYXAgPSBuZXcgTWFwPHRzLlN5bnRheEtpbmQsIEhhbmRsZXJbXT4oKTtcbiAgcHJpdmF0ZSBmYWlsdXJlczogRmFpbHVyZVtdID0gW107XG4gIHByaXZhdGUgY3VycmVudFNvdXJjZUZpbGU6IHRzLlNvdXJjZUZpbGV8dW5kZWZpbmVkO1xuICAvLyBjdXJyZW50Q29kZSB3aWxsIGJlIHNldCBiZWZvcmUgaW52b2tpbmcgYW55IGhhbmRsZXIgZnVuY3Rpb25zIHNvIHRoZSB2YWx1ZVxuICAvLyBpbml0aWFsaXplZCBoZXJlIGlzIG5ldmVyIHVzZWQuXG4gIHByaXZhdGUgY3VycmVudENvZGUgPSAwO1xuICAvKipcbiAgICogQWxsb3cgdHlwZWQgcnVsZXMgdmlhIHR5cGVDaGVja2VyLlxuICAgKi9cbiAgdHlwZUNoZWNrZXI6IHRzLlR5cGVDaGVja2VyO1xuXG4gIGNvbnN0cnVjdG9yKHByb2dyYW06IHRzLlByb2dyYW0pIHtcbiAgICAvLyBBdm9pZCB0aGUgY29zdCBmb3IgZWFjaCBydWxlIHRvIGNyZWF0ZSBhIG5ldyBUeXBlQ2hlY2tlci5cbiAgICB0aGlzLnR5cGVDaGVja2VyID0gcHJvZ3JhbS5nZXRUeXBlQ2hlY2tlcigpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoaXMgZG9lc24ndCBydW4gYW55IGNoZWNrcyB5ZXQuIEluc3RlYWQsIGl0IHJlZ2lzdGVycyBgaGFuZGxlckZ1bmN0aW9uYCBvblxuICAgKiBgbm9kZUtpbmRgIG5vZGUgaW4gYG5vZGVIYW5kbGVyc01hcGAgbWFwLiBBZnRlciBhbGwgcnVsZXMgcmVnaXN0ZXIgdGhlaXJcbiAgICogaGFuZGxlcnMsIHRoZSBzb3VyY2UgZmlsZSBBU1Qgd2lsbCBiZSB0cmF2ZXJzZWQuXG4gICAqL1xuICBvbjxUIGV4dGVuZHMgdHMuTm9kZT4oXG4gICAgICBub2RlS2luZDogVFsna2luZCddLCBoYW5kbGVyRnVuY3Rpb246IChjaGVja2VyOiBDaGVja2VyLCBub2RlOiBUKSA9PiB2b2lkLFxuICAgICAgY29kZTogbnVtYmVyKSB7XG4gICAgY29uc3QgbmV3SGFuZGxlcjogSGFuZGxlciA9IHtoYW5kbGVyRnVuY3Rpb24sIGNvZGV9O1xuICAgIGNvbnN0IHJlZ2lzdGVyZWRIYW5kbGVyczogSGFuZGxlcltdfHVuZGVmaW5lZCA9XG4gICAgICAgIHRoaXMubm9kZUhhbmRsZXJzTWFwLmdldChub2RlS2luZCk7XG4gICAgaWYgKHJlZ2lzdGVyZWRIYW5kbGVycyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aGlzLm5vZGVIYW5kbGVyc01hcC5zZXQobm9kZUtpbmQsIFtuZXdIYW5kbGVyXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlZ2lzdGVyZWRIYW5kbGVycy5wdXNoKG5ld0hhbmRsZXIpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBZGQgYSBmYWlsdXJlIHdpdGggYSBzcGFuLiBhZGRGYWlsdXJlKCkgaXMgY3VycmVudGx5IHByaXZhdGUgYmVjYXVzZVxuICAgKiBgYWRkRmFpbHVyZUF0Tm9kZWAgaXMgcHJlZmVycmVkLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRGYWlsdXJlKFxuICAgICAgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIsIGZhaWx1cmVUZXh0OiBzdHJpbmcsIGZpeD86IEZpeCkge1xuICAgIGlmICghdGhpcy5jdXJyZW50U291cmNlRmlsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdTb3VyY2UgZmlsZSBub3QgZGVmaW5lZCcpO1xuICAgIH1cbiAgICBpZiAoc3RhcnQgPj0gZW5kIHx8IGVuZCA+IHRoaXMuY3VycmVudFNvdXJjZUZpbGUuZW5kIHx8IHN0YXJ0IDwgMCkge1xuICAgICAgLy8gU2luY2Ugb25seSBhZGRGYWlsdXJlQXROb2RlKCkgaXMgZXhwb3NlZCBmb3Igbm93IHRoaXMgc2hvdWxkbid0IGhhcHBlbi5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgSW52YWxpZCBzdGFydCBhbmQgZW5kIHBvc2l0aW9uOiBbJHtzdGFydH0sICR7ZW5kfV1gICtcbiAgICAgICAgICBgIGluIGZpbGUgJHt0aGlzLmN1cnJlbnRTb3VyY2VGaWxlLmZpbGVOYW1lfS5gKTtcbiAgICB9XG5cbiAgICBjb25zdCBmYWlsdXJlID0gbmV3IEZhaWx1cmUoXG4gICAgICAgIHRoaXMuY3VycmVudFNvdXJjZUZpbGUsIHN0YXJ0LCBlbmQsIGZhaWx1cmVUZXh0LCB0aGlzLmN1cnJlbnRDb2RlLCBmaXgpO1xuICAgIHRoaXMuZmFpbHVyZXMucHVzaChmYWlsdXJlKTtcbiAgfVxuXG4gIGFkZEZhaWx1cmVBdE5vZGUobm9kZTogdHMuTm9kZSwgZmFpbHVyZVRleHQ6IHN0cmluZywgZml4PzogRml4KSB7XG4gICAgLy8gbm9kZS5nZXRTdGFydCgpIHRha2VzIGEgc291cmNlRmlsZSBhcyBhcmd1bWVudCB3aGVyZWFzIG5vZGUuZ2V0RW5kKClcbiAgICAvLyBkb2Vzbid0IG5lZWQgaXQuXG4gICAgdGhpcy5hZGRGYWlsdXJlKFxuICAgICAgICBub2RlLmdldFN0YXJ0KHRoaXMuY3VycmVudFNvdXJjZUZpbGUpLCBub2RlLmdldEVuZCgpLCBmYWlsdXJlVGV4dCwgZml4KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXYWxrIGBzb3VyY2VGaWxlYCwgaW52b2tpbmcgcmVnaXN0ZXJlZCBoYW5kbGVycyB3aXRoIENoZWNrZXIgYXMgdGhlIGZpcnN0XG4gICAqIGFyZ3VtZW50IGFuZCBjdXJyZW50IG5vZGUgYXMgdGhlIHNlY29uZCBhcmd1bWVudC4gUmV0dXJuIGZhaWx1cmVzIGlmIHRoZXJlXG4gICAqIGFyZSBhbnkuXG4gICAqL1xuICBleGVjdXRlKHNvdXJjZUZpbGU6IHRzLlNvdXJjZUZpbGUpOiBGYWlsdXJlW10ge1xuICAgIGNvbnN0IHRoaXNDaGVja2VyID0gdGhpcztcbiAgICB0aGlzLmN1cnJlbnRTb3VyY2VGaWxlID0gc291cmNlRmlsZTtcbiAgICB0aGlzLmZhaWx1cmVzID0gW107XG4gICAgdHMuZm9yRWFjaENoaWxkKHNvdXJjZUZpbGUsIHJ1bik7XG4gICAgcmV0dXJuIHRoaXMuZmFpbHVyZXM7XG5cbiAgICBmdW5jdGlvbiBydW4obm9kZTogdHMuTm9kZSkge1xuICAgICAgY29uc3QgaGFuZGxlcnM6IEhhbmRsZXJbXXx1bmRlZmluZWQgPVxuICAgICAgICAgIHRoaXNDaGVja2VyLm5vZGVIYW5kbGVyc01hcC5nZXQobm9kZS5raW5kKTtcbiAgICAgIGlmIChoYW5kbGVycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICAgIHRoaXNDaGVja2VyLmN1cnJlbnRDb2RlID0gaGFuZGxlci5jb2RlO1xuICAgICAgICAgIGhhbmRsZXIuaGFuZGxlckZ1bmN0aW9uKHRoaXNDaGVja2VyLCBub2RlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdHMuZm9yRWFjaENoaWxkKG5vZGUsIHJ1bik7XG4gICAgfVxuICB9XG59XG4iXX0=