/**
 * @fileoverview extensions to TypeScript functionality around error handling
 * (ts.Diagnostics).
 */
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "typescript"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const ts = require("typescript");
    /**
     * If the current compilation was a compilation test expecting certain
     * diagnostics, filter out the expected diagnostics, and add new diagnostics
     * (aka errors) for non-matched diagnostics.
     */
    function filterExpected(bazelOpts, diagnostics, formatFn = uglyFormat) {
        if (!bazelOpts.expectedDiagnostics.length)
            return diagnostics;
        // The regex contains two parts:
        // 1. Optional position: '\(5,1\)'
        // 2. Required TS error: 'TS2000: message text.'
        // Need triple escapes because the expected diagnostics that we're matching
        // here are regexes, too.
        const ERROR_RE = /^(?:\\\((\d*),(\d*)\\\).*)?TS(\d+):(.*)/;
        const incorrectErrors = bazelOpts.expectedDiagnostics.filter(e => !e.match(ERROR_RE));
        if (incorrectErrors.length) {
            const msg = `Expected errors must match regex ${ERROR_RE}\n\t` +
                `expected errors are "${incorrectErrors.join(', ')}"`;
            return [{
                    file: undefined,
                    start: 0,
                    length: 0,
                    messageText: msg,
                    category: ts.DiagnosticCategory.Error,
                    code: 0,
                }];
        }
        const expectedDiags = bazelOpts.expectedDiagnostics.map(expected => {
            const m = expected.match(/^(?:\\\((\d*),(\d*)\\\).*)?TS(\d+):(.*)$/);
            if (!m) {
                throw new Error('Incorrect expected error, did you forget character escapes in ' +
                    expected);
            }
            const [, lineStr, columnStr, codeStr, regexp] = m;
            const [line, column, code] = [lineStr, columnStr, codeStr].map(str => {
                const i = Number(str);
                if (Number.isNaN(i)) {
                    return 0;
                }
                return i;
            });
            return {
                line,
                column,
                expected,
                code,
                regexp: new RegExp(regexp),
                matched: false,
            };
        });
        const unmatchedDiags = diagnostics.filter(diag => {
            let line = -1;
            let character = -1;
            if (diag.file && diag.start) {
                ({ line, character } =
                    ts.getLineAndCharacterOfPosition(diag.file, diag.start));
            }
            let matched = false;
            const msg = formatFn(bazelOpts.target, [diag]);
            // checkDiagMatchesExpected checks if the expected diagnostics matches the
            // actual diagnostics.
            const checkDiagMatchesExpected = (expDiag, diag) => {
                if (expDiag.code !== diag.code || msg.search(expDiag.regexp) === -1) {
                    return false;
                }
                // line and column are optional fields, only check them if they
                // are explicitly specified.
                // line and character are zero based.
                if (expDiag.line !== 0 && expDiag.line !== line + 1) {
                    return false;
                }
                if (expDiag.column !== 0 && expDiag.column !== character + 1) {
                    return false;
                }
                return true;
            };
            for (const expDiag of expectedDiags) {
                if (checkDiagMatchesExpected(expDiag, diag)) {
                    expDiag.matched = true;
                    matched = true;
                    // continue, one diagnostic may match multiple expected errors.
                }
            }
            return !matched;
        });
        const unmatchedErrors = expectedDiags.filter(err => !err.matched).map(err => {
            const file = ts.createSourceFile(bazelOpts.target, '/* fake source as marker */', ts.ScriptTarget.Latest);
            const messageText = `Expected a compilation error matching ${JSON.stringify(err.expected)}`;
            return {
                file,
                start: 0,
                length: 0,
                messageText,
                category: ts.DiagnosticCategory.Error,
                code: err.code,
            };
        });
        return unmatchedDiags.concat(unmatchedErrors);
    }
    exports.filterExpected = filterExpected;
    /**
     * Formats the given diagnostics, without pretty printing.  Without colors, it's
     * better for matching against programmatically.
     * @param target The bazel target, e.g. //my/package:target
     */
    function uglyFormat(target, diagnostics) {
        const diagnosticsHost = {
            getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
            getNewLine: () => ts.sys.newLine,
            // Print filenames including their relativeRoot, so they can be located on
            // disk
            getCanonicalFileName: (f) => f
        };
        return ts.formatDiagnostics(diagnostics, diagnosticsHost);
    }
    exports.uglyFormat = uglyFormat;
    /**
     * Pretty formats the given diagnostics (matching the --pretty tsc flag).
     * @param target The bazel target, e.g. //my/package:target
     */
    function format(target, diagnostics) {
        const diagnosticsHost = {
            getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
            getNewLine: () => ts.sys.newLine,
            // Print filenames including their relativeRoot, so they can be located on
            // disk
            getCanonicalFileName: (f) => f
        };
        return ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost);
    }
    exports.format = format;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlhZ25vc3RpY3MuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzY193cmFwcGVkL2RpYWdub3N0aWNzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7R0FHRzs7Ozs7Ozs7Ozs7O0lBRUgsaUNBQWlDO0lBSWpDOzs7O09BSUc7SUFDSCxTQUFnQixjQUFjLENBQzFCLFNBQXVCLEVBQUUsV0FBNEIsRUFDckQsUUFBUSxHQUFHLFVBQVU7UUFDdkIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNO1lBQUUsT0FBTyxXQUFXLENBQUM7UUFFOUQsZ0NBQWdDO1FBQ2hDLGtDQUFrQztRQUNsQyxnREFBZ0Q7UUFDaEQsMkVBQTJFO1FBQzNFLHlCQUF5QjtRQUN6QixNQUFNLFFBQVEsR0FBRyx5Q0FBeUMsQ0FBQztRQUMzRCxNQUFNLGVBQWUsR0FDakIsU0FBUyxDQUFDLG1CQUFtQixDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO1FBQ2xFLElBQUksZUFBZSxDQUFDLE1BQU0sRUFBRTtZQUMxQixNQUFNLEdBQUcsR0FBRyxvQ0FBb0MsUUFBUSxNQUFNO2dCQUMxRCx3QkFBd0IsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO1lBQzFELE9BQU8sQ0FBQztvQkFDTixJQUFJLEVBQUUsU0FBVTtvQkFDaEIsS0FBSyxFQUFFLENBQUM7b0JBQ1IsTUFBTSxFQUFFLENBQUM7b0JBQ1QsV0FBVyxFQUFFLEdBQUc7b0JBQ2hCLFFBQVEsRUFBRSxFQUFFLENBQUMsa0JBQWtCLENBQUMsS0FBSztvQkFDckMsSUFBSSxFQUFFLENBQUM7aUJBQ1IsQ0FBQyxDQUFDO1NBQ0o7UUFjRCxNQUFNLGFBQWEs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V0FBVyxFQUFFLGVBQWUsQ0FBQyxDQUFDO0lBQzVELENBQUM7SUFWRCxnQ0FVQztJQUVEOzs7T0FHRztJQUNILFNBQWdCLE1BQU0sQ0FDbEIsTUFBYyxFQUFFLFdBQXlDO1FBQzNELE1BQU0sZUFBZSxHQUE2QjtZQUNoRCxtQkFBbUIsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLG1CQUFtQixFQUFFO1lBQ3ZELFVBQVUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLE9BQU87WUFDaEMsMEVBQTBFO1lBQzFFLE9BQU87WUFDUCxvQkFBb0IsRUFBRSxDQUFDLENBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQztTQUN2QyxDQUFDO1FBQ0YsT0FBTyxFQUFFLENBQUMsb0NBQW9DLENBQUMsV0FBVyxFQUFFLGVBQWUsQ0FBQyxDQUFDO0lBQy9FLENBQUM7SUFWRCx3QkFVQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGZpbGVvdmVydmlldyBleHRlbnNpb25zIHRvIFR5cGVTY3JpcHQgZnVuY3Rpb25hbGl0eSBhcm91bmQgZXJyb3IgaGFuZGxpbmdcbiAqICh0cy5EaWFnbm9zdGljcykuXG4gKi9cblxuaW1wb3J0ICogYXMgdHMgZnJvbSAndHlwZXNjcmlwdCc7XG5cbmltcG9ydCB7QmF6ZWxPcHRpb25zfSBmcm9tICcuL3RzY29uZmlnJztcblxuLyoqXG4gKiBJZiB0aGUgY3VycmVudCBjb21waWxhdGlvbiB3YXMgYSBjb21waWxhdGlvbiB0ZXN0IGV4cGVjdGluZyBjZXJ0YWluXG4gKiBkaWFnbm9zdGljcywgZmlsdGVyIG91dCB0aGUgZXhwZWN0ZWQgZGlhZ25vc3RpY3MsIGFuZCBhZGQgbmV3IGRpYWdub3N0aWNzXG4gKiAoYWthIGVycm9ycykgZm9yIG5vbi1tYXRjaGVkIGRpYWdub3N0aWNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsdGVyRXhwZWN0ZWQoXG4gICAgYmF6ZWxPcHRzOiBCYXplbE9wdGlvbnMsIGRpYWdub3N0aWNzOiB0cy5EaWFnbm9zdGljW10sXG4gICAgZm9ybWF0Rm4gPSB1Z2x5Rm9ybWF0KTogdHMuRGlhZ25vc3RpY1tdIHtcbiAgaWYgKCFiYXplbE9wdHMuZXhwZWN0ZWREaWFnbm9zdGljcy5sZW5ndGgpIHJldHVybiBkaWFnbm9zdGljcztcblxuICAvLyBUaGUgcmVnZXggY29udGFpbnMgdHdvIHBhcnRzOlxuICAvLyAxLiBPcHRpb25hbCBwb3NpdGlvbjogJ1xcKDUsMVxcKSdcbiAgLy8gMi4gUmVxdWlyZWQgVFMgZXJyb3I6ICdUUzIwMDA6IG1lc3NhZ2UgdGV4dC4nXG4gIC8vIE5lZWQgdHJpcGxlIGVzY2FwZXMgYmVjYXVzZSB0aGUgZXhwZWN0ZWQgZGlhZ25vc3RpY3MgdGhhdCB3ZSdyZSBtYXRjaGluZ1xuICAvLyBoZXJlIGFyZSByZWdleGVzLCB0b28uXG4gIGNvbnN0IEVSUk9SX1JFID0gL14oPzpcXFxcXFwoKFxcZCopLChcXGQqKVxcXFxcXCkuKik/VFMoXFxkKyk6KC4qKS87XG4gIGNvbnN0IGluY29ycmVjdEVycm9ycyA9XG4gICAgICBiYXplbE9wdHMuZXhwZWN0ZWREaWFnbm9zdGljcy5maWx0ZXIoZSA9PiAhZS5tYXRjaChFUlJPUl9SRSkpO1xuICBpZiAoaW5jb3JyZWN0RXJyb3JzLmxlbmd0aCkge1xuICAgIGNvbnN0IG1zZyA9IGBFeHBlY3RlZCBlcnJvcnMgbXVzdCBtYXRjaCByZWdleCAke0VSUk9SX1JFfVxcblxcdGAgK1xuICAgICAgICBgZXhwZWN0ZWQgZXJyb3JzIGFyZSBcIiR7aW5jb3JyZWN0RXJyb3JzLmpvaW4oJywgJyl9XCJgO1xuICAgIHJldHVybiBbe1xuICAgICAgZmlsZTogdW5kZWZpbmVkISxcbiAgICAgIHN0YXJ0OiAwLFxuICAgICAgbGVuZ3RoOiAwLFxuICAgICAgbWVzc2FnZVRleHQ6IG1zZyxcbiAgICAgIGNhdGVnb3J5OiB0cy5EaWFnbm9zdGljQ2F0ZWdvcnkuRXJyb3IsXG4gICAgICBjb2RlOiAwLFxuICAgIH1dO1xuICB9XG5cbiAgLy8gRXhwZWN0ZWREaWFnbm9zdGljcyByZXByZXNlbnRzIHRoZSBcImV4cGVjdGVkX2RpYWdub3N0aWNzXCIgdXNlcnMgcHJvdmlkZSBpblxuICAvLyB0aGUgQlVJTEQgZmlsZS4gSXQgaXMgdXNlZCBmb3IgZWFzaWVyIGNvbXBhcnNpb24gd2l0aCB0aGUgYWN0dWFsXG4gIC8vIGRpYWdub3N0aWNzLlxuICBpbnRlcmZhY2UgRXhwZWN0ZWREaWFnbm9zdGljcyB7XG4gICAgbGluZTogbnVtYmVyO1xuICAgIGNvbHVtbjogbnVtYmVyO1xuICAgIGV4cGVjdGVkOiBzdHJpbmc7XG4gICAgY29kZTogbnVtYmVyO1xuICAgIHJlZ2V4cDogUmVnRXhwO1xuICAgIG1hdGNoZWQ6IGJvb2xlYW47XG4gIH1cblxuICBjb25zdCBleHBlY3RlZERpYWdzOiBFeHBlY3RlZERpYWdub3N0aWNzW10gPVxuICAgICAgYmF6ZWxPcHRzLmV4cGVjdGVkRGlhZ25vc3RpY3MubWFwKGV4cGVjdGVkID0+IHtcbiAgICAgICAgY29uc3QgbSA9IGV4cGVjdGVkLm1hdGNoKC9eKD86XFxcXFxcKChcXGQqKSwoXFxkKilcXFxcXFwpLiopP1RTKFxcZCspOiguKikkLyk7XG4gICAgICAgIGlmICghbSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgJ0luY29ycmVjdCBleHBlY3RlZCBlcnJvciwgZGlkIHlvdSBmb3JnZXQgY2hhcmFjdGVyIGVzY2FwZXMgaW4gJyArXG4gICAgICAgICAgICAgIGV4cGVjdGVkKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBbLCBsaW5lU3RyLCBjb2x1bW5TdHIsIGNvZGVTdHIsIHJlZ2V4cF0gPSBtO1xuICAgICAgICBjb25zdCBbbGluZSwgY29sdW1uLCBjb2RlXSA9IFtsaW5lU3RyLCBjb2x1bW5TdHIsIGNvZGVTdHJdLm1hcChzdHIgPT4ge1xuICAgICAgICAgIGNvbnN0IGkgPSBOdW1iZXIoc3RyKTtcbiAgICAgICAgICBpZiAoTnVtYmVyLmlzTmFOKGkpKSB7XG4gICAgICAgICAgICByZXR1cm4gMDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxpbmUsXG4gICAgICAgICAgY29sdW1uLFxuICAgICAgICAgIGV4cGVjdGVkLFxuICAgICAgICAgIGNvZGUsXG4gICAgICAgICAgcmVnZXhwOiBuZXcgUmVnRXhwKHJlZ2V4cCksXG4gICAgICAgICAgbWF0Y2hlZDogZmFsc2UsXG4gICAgICAgIH07XG4gICAgICB9KTtcblxuICBjb25zdCB1bm1hdGNoZWREaWFncyA9IGRpYWdub3N0aWNzLmZpbHRlcihkaWFnID0+IHtcbiAgICBsZXQgbGluZSA9IC0xO1xuICAgIGxldCBjaGFyYWN0ZXIgPSAtMTtcbiAgICBpZiAoZGlhZy5maWxlICYmIGRpYWcuc3RhcnQpIHtcbiAgICAgICh7bGluZSwgY2hhcmFjdGVyfSA9XG4gICAgICAgICAgIHRzLmdldExpbmVBbmRDaGFyYWN0ZXJPZlBvc2l0aW9uKGRpYWcuZmlsZSwgZGlhZy5zdGFydCkpO1xuICAgIH1cbiAgICBsZXQgbWF0Y2hlZCA9IGZhbHNlO1xuICAgIGNvbnN0IG1zZyA9IGZvcm1hdEZuKGJhemVsT3B0cy50YXJnZXQsIFtkaWFnXSk7XG4gICAgLy8gY2hlY2tEaWFnTWF0Y2hlc0V4cGVjdGVkIGNoZWNrcyBpZiB0aGUgZXhwZWN0ZWQgZGlhZ25vc3RpY3MgbWF0Y2hlcyB0aGVcbiAgICAvLyBhY3R1YWwgZGlhZ25vc3RpY3MuXG4gICAgY29uc3QgY2hlY2tEaWFnTWF0Y2hlc0V4cGVjdGVkID1cbiAgICAgICAgKGV4cERpYWc6IEV4cGVjdGVkRGlhZ25vc3RpY3MsIGRpYWc6IHRzLkRpYWdub3N0aWMpID0+IHtcbiAgICAgICAgICBpZiAoZXhwRGlhZy5jb2RlICE9PSBkaWFnLmNvZGUgfHwgbXNnLnNlYXJjaChleHBEaWFnLnJlZ2V4cCkgPT09IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIGxpbmUgYW5kIGNvbHVtbiBhcmUgb3B0aW9uYWwgZmllbGRzLCBvbmx5IGNoZWNrIHRoZW0gaWYgdGhleVxuICAgICAgICAgIC8vIGFyZSBleHBsaWNpdGx5IHNwZWNpZmllZC5cbiAgICAgICAgICAvLyBsaW5lIGFuZCBjaGFyYWN0ZXIgYXJlIHplcm8gYmFzZWQuXG4gICAgICAgICAgaWYgKGV4cERpYWcubGluZSAhPT0gMCAmJiBleHBEaWFnLmxpbmUgIT09IGxpbmUgKyAxKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChleHBEaWFnLmNvbHVtbiAhPT0gMCAmJiBleHBEaWFnLmNvbHVtbiAhPT0gY2hhcmFjdGVyICsgMSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfTtcblxuICAgIGZvciAoY29uc3QgZXhwRGlhZyBvZiBleHBlY3RlZERpYWdzKSB7XG4gICAgICBpZiAoY2hlY2tEaWFnTWF0Y2hlc0V4cGVjdGVkKGV4cERpYWcsIGRpYWcpKSB7XG4gICAgICAgIGV4cERpYWcubWF0Y2hlZCA9IHRydWU7XG4gICAgICAgIG1hdGNoZWQgPSB0cnVlO1xuICAgICAgICAvLyBjb250aW51ZSwgb25lIGRpYWdub3N0aWMgbWF5IG1hdGNoIG11bHRpcGxlIGV4cGVjdGVkIGVycm9ycy5cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuICFtYXRjaGVkO1xuICB9KTtcblxuICBjb25zdCB1bm1hdGNoZWRFcnJvcnMgPSBleHBlY3RlZERpYWdzLmZpbHRlcihlcnIgPT4gIWVyci5tYXRjaGVkKS5tYXAoZXJyID0+IHtcbiAgICBjb25zdCBmaWxlID0gdHMuY3JlYXRlU291cmNlRmlsZShcbiAgICAgICAgYmF6ZWxPcHRzLnRhcmdldCwgJy8qIGZha2Ugc291cmNlIGFzIG1hcmtlciAqLycsXG4gICAgICAgIHRzLlNjcmlwdFRhcmdldC5MYXRlc3QpO1xuICAgIGNvbnN0IG1lc3NhZ2VUZXh0ID1cbiAgICAgICAgYEV4cGVjdGVkIGEgY29tcGlsYXRpb24gZXJyb3IgbWF0Y2hpbmcgJHtKU09OLnN0cmluZ2lmeShlcnIuZXhwZWN0ZWQpfWA7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZpbGUsXG4gICAgICBzdGFydDogMCxcbiAgICAgIGxlbmd0aDogMCxcbiAgICAgIG1lc3NhZ2VUZXh0LFxuICAgICAgY2F0ZWdvcnk6IHRzLkRpYWdub3N0aWNDYXRlZ29yeS5FcnJvcixcbiAgICAgIGNvZGU6IGVyci5jb2RlLFxuICAgIH07XG4gIH0pO1xuXG4gIHJldHVybiB1bm1hdGNoZWREaWFncy5jb25jYXQodW5tYXRjaGVkRXJyb3JzKTtcbn1cblxuLyoqXG4gKiBGb3JtYXRzIHRoZSBnaXZlbiBkaWFnbm9zdGljcywgd2l0aG91dCBwcmV0dHkgcHJpbnRpbmcuICBXaXRob3V0IGNvbG9ycywgaXQnc1xuICogYmV0dGVyIGZvciBtYXRjaGluZyBhZ2FpbnN0IHByb2dyYW1tYXRpY2FsbHkuXG4gKiBAcGFyYW0gdGFyZ2V0IFRoZSBiYXplbCB0YXJnZXQsIGUuZy4gLy9teS9wYWNrYWdlOnRhcmdldFxuICovXG5leHBvcnQgZnVuY3Rpb24gdWdseUZvcm1hdChcbiAgICB0YXJnZXQ6IHN0cmluZywgZGlhZ25vc3RpY3M6IFJlYWRvbmx5QXJyYXk8dHMuRGlhZ25vc3RpYz4pOiBzdHJpbmcge1xuICBjb25zdCBkaWFnbm9zdGljc0hvc3Q6IHRzLkZvcm1hdERpYWdub3N0aWNzSG9zdCA9IHtcbiAgICBnZXRDdXJyZW50RGlyZWN0b3J5OiAoKSA9PiB0cy5zeXMuZ2V0Q3VycmVudERpcmVjdG9yeSgpLFxuICAgIGdldE5ld0xpbmU6ICgpID0+IHRzLnN5cy5uZXdMaW5lLFxuICAgIC8vIFByaW50IGZpbGVuYW1lcyBpbmNsdWRpbmcgdGhlaXIgcmVsYXRpdmVSb290LCBzbyB0aGV5IGNhbiBiZSBsb2NhdGVkIG9uXG4gICAgLy8gZGlza1xuICAgIGdldENhbm9uaWNhbEZpbGVOYW1lOiAoZjogc3RyaW5nKSA9PiBmXG4gIH07XG4gIHJldHVybiB0cy5mb3JtYXREaWFnbm9zdGljcyhkaWFnbm9zdGljcywgZGlhZ25vc3RpY3NIb3N0KTtcbn1cblxuLyoqXG4gKiBQcmV0dHkgZm9ybWF0cyB0aGUgZ2l2ZW4gZGlhZ25vc3RpY3MgKG1hdGNoaW5nIHRoZSAtLXByZXR0eSB0c2MgZmxhZykuXG4gKiBAcGFyYW0gdGFyZ2V0IFRoZSBiYXplbCB0YXJnZXQsIGUuZy4gLy9teS9wYWNrYWdlOnRhcmdldFxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0KFxuICAgIHRhcmdldDogc3RyaW5nLCBkaWFnbm9zdGljczogUmVhZG9ubHlBcnJheTx0cy5EaWFnbm9zdGljPik6IHN0cmluZyB7XG4gIGNvbnN0IGRpYWdub3N0aWNzSG9zdDogdHMuRm9ybWF0RGlhZ25vc3RpY3NIb3N0ID0ge1xuICAgIGdldEN1cnJlbnREaXJlY3Rvcnk6ICgpID0+IHRzLnN5cy5nZXRDdXJyZW50RGlyZWN0b3J5KCksXG4gICAgZ2V0TmV3TGluZTogKCkgPT4gdHMuc3lzLm5ld0xpbmUsXG4gICAgLy8gUHJpbnQgZmlsZW5hbWVzIGluY2x1ZGluZyB0aGVpciByZWxhdGl2ZVJvb3QsIHNvIHRoZXkgY2FuIGJlIGxvY2F0ZWQgb25cbiAgICAvLyBkaXNrXG4gICAgZ2V0Q2Fub25pY2FsRmlsZU5hbWU6IChmOiBzdHJpbmcpID0+IGZcbiAgfTtcbiAgcmV0dXJuIHRzLmZvcm1hdERpYWdub3N0aWNzV2l0aENvbG9yQW5kQ29udGV4dChkaWFnbm9zdGljcywgZGlhZ25vc3RpY3NIb3N0KTtcbn1cbiJdfQ==