/**
 * @fileoverview A Tsetse rule that checks the return value of certain functions
 * must be used.
 */
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "tsutils", "typescript", "../error_code", "../rule"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const tsutils = require("tsutils");
    const ts = require("typescript");
    const error_code_1 = require("../error_code");
    const rule_1 = require("../rule");
    const FAILURE_STRING = 'return value is unused.'
        + '\n\tSee http://tsetse.info/check-return-value';
    // A list of well-known functions that the return value must be used. If unused
    // then the function call is either a no-op (e.g. 'foo.trim()' foo is unchanged)
    // or can be replaced by another (Array.map() should be replaced with a loop or
    // Array.forEach() if the return value is unused).
    const METHODS_TO_CHECK = new Set([
        ['Array', 'concat'],
        ['Array', 'filter'],
        ['Array', 'map'],
        ['Array', 'slice'],
        ['Function', 'bind'],
        ['Object', 'create'],
        ['string', 'concat'],
        ['string', 'normalize'],
        ['string', 'padStart'],
        ['string', 'padEnd'],
        ['string', 'repeat'],
        ['string', 'slice'],
        ['string', 'split'],
        ['string', 'substr'],
        ['string', 'substring'],
        ['string', 'toLocaleLowerCase'],
        ['string', 'toLocaleUpperCase'],
        ['string', 'toLowerCase'],
        ['string', 'toUpperCase'],
        ['string', 'trim'],
    ].map(list => list.join('#')));
    class Rule extends rule_1.AbstractRule {
        constructor() {
            super(...arguments);
            this.ruleName = 'check-return-value';
            this.code = error_code_1.ErrorCode.CHECK_RETURN_VALUE;
        }
        // registers checkCallExpression() function on ts.CallExpression node.
        // TypeScript conformance will traverse the AST of each source file and run
        // checkCallExpression() every time it encounters a ts.CallExpression node.
        register(checker) {
            checker.on(ts.SyntaxKind.CallExpression, checkCallExpression, this.code);
        }
    }
    exports.Rule = Rule;
    function checkCallExpression(checker, node) {
        // Short-circuit before using the typechecker if possible, as its expensive.
        // Workaround for https://github.com/Microsoft/TypeScript/issues/27997
        if (tsutils.isExpressionValueUsed(node)) {
            return;
        }
        // Check if this CallExpression is one of the well-known functions and returns
        // a non-void value that is unused.
        const signature = checker.typeChecker.getResolvedSignature(node);
        if (signature !== undefined) {
            const returnType = checker.typeChecker.getReturnTypeOfSignature(signature);
            if (!!(returnType.flags & ts.TypeFlags.Void)) {
                return;
            }
            // Although hasCheckReturnValueJsDoc() is faster than isBlackListed(), it
            // returns false most of the time and thus isBlackListed() would have to run
            // anyway. Therefore we short-circuit hasCheckReturnValueJsDoc().
            if (!isBlackListed(node, checker.typeChecker) &&
                !hasCheckReturnValueJsDoc(node, checker.typeChecker)) {
                return;
            }
            checker.addFailureAtNode(node, FAILURE_STRING);
        }
    }
    function isBlackListed(node, tc) {
        switch (node.expression.kind) {
            case ts.SyntaxKind.PropertyAccessExpression:
            case ts.SyntaxKind.ElementAccessExpression:
                // Example: foo.bar() or foo[bar]()
                // expressionNode is foo
                const nodeExpression = node.expression.expression;
                const nodeExpressionString = nodeExpression.getText();
                const nodeType = tc.getTypeAtLocation(nodeExpression);
                // nodeTypeString is the string representation of the type of foo
                let nodeTypeString = tc.typeToString(nodeType);
                if (nodeTypeString.endsWith('[]')) {
                    nodeTypeString = 'Array';
                }
                if (nodeTypeString === 'ObjectConstructor') {
                    nodeTypeString = 'Object';
                }
                if (tsutils.isTypeFlagSet(nodeType, ts.TypeFlags.StringLiteral)) {
                    nodeTypeString = 'string';
                }
                // nodeFunction is bar
                let nodeFunction = '';
                if (tsutils.isPropertyAccessExpression(node.expression)) {
                    nodeFunction = node.expression.name.getText();
                }
                if (tsutils.isElementAccessExpression(node.expression)) {
                    const argument = node.expression.argumentExpression;
                    if (argument !== undefined) {
                        nodeFunction = argument.getText();
                    }
                }
                // Check if 'foo#bar' or `${typeof foo}#bar` is in the blacklist.
                if (METHODS_TO_CHECK.has(`${nodeTypeString}#${nodeFunction}`) ||
                    METHODS_TO_CHECK.has(`${nodeExpressionString}#${nodeFunction}`)) {
                    return true;
                }
                // For 'str.replace(regexp|substr, newSubstr|function)' only check when
                // the second parameter is 'newSubstr'.
                if ((`${nodeTypeString}#${nodeFunction}` === 'string#replace') ||
                    (`${nodeExpressionString}#${nodeFunction}` === 'string#replace')) {
                    return node.arguments.length === 2 &&
                        !tsutils.isFunctionWithBody(node.arguments[1]);
                }
                break;
            case ts.SyntaxKind.Identifier:
                // Example: foo()
                // We currently don't have functions of this kind in blacklist.
                const identifier = node.expression;
                if (METHODS_TO_CHECK.has(identifier.text)) {
                    return true;
                }
                break;
            default:
                break;
        }
        return false;
    }
    function hasCheckReturnValueJsDoc(node, tc) {
        let symbol = tc.getSymbolAtLocation(node.expression);
        if (symbol === undefined) {
            return false;
        }
        if (tsutils.isSymbolFlagSet(symbol, ts.SymbolFlags.Alias)) {
            symbol = tc.getAliasedSymbol(symbol);
        }
        for (const jsDocTagInfo of symbol.getJsDocTags()) {
            if (jsDocTagInfo.name === 'checkReturnValue') {
                return true;
            }
        }
        return false;
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hlY2tfcmV0dXJuX3ZhbHVlX3J1bGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi8uLi9leHRlcm5hbC9idWlsZF9iYXplbF9ydWxlc190eXBlc2NyaXB0L2ludGVybmFsL3RzZXRzZS9ydWxlcy9jaGVja19yZXR1cm5fdmFsdWVfcnVsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQTs7O0dBR0c7Ozs7Ozs7Ozs7OztJQUVILG1DQUFtQztJQUNuQyxpQ0FBaUM7SUFHakMsOENBQXdDO0lBQ3hDLGtDQUFxQztJQUVyQyxNQUFNLGNBQWMsR0FBRyx5QkFBeUI7VUFDMUMsK0NBQStDLENBQUM7SUFFdEQsK0VBQStFO0lBQy9FLGdGQUFnRjtJQUNoRiwrRUFBK0U7SUFDL0Usa0RBQWtEO0lBQ2xELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLENBQVM7UUFDdkMsQ0FBQyxPQUFPLEVBQUUsUUFBUSxDQUFDO1FBQ25CLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQztRQUNuQixDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUM7UUFDaEIsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDO1FBQ2xCLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQztRQUNwQixDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUM7UUFDcEIsQ0FBQyxRQUFRLEVBQUUsUUFBUSxDQUFDO1FBQ3BCLENBQUMsUUFBUSxFQUFFLFdBQVcsQ0FBQztRQUN2QixDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUM7UUFDdEIsQ0FBQyxRQUFRLEVBQUUsUUFBUSxDQUFDO1FBQ3BCLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQztRQUNwQixDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUM7UUFDbkIsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDO1FBQ25CLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQztRQUNwQixDQUFDLFFBQVEsRUFBRSxXQUFXLENBQUM7UUFDdkIsQ0FBQyxR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RSxDQUFDLFVBQVUsQ0FBQyxVQUFVO2dCQUMzQixpQkFBaUI7Z0JBQ2pCLCtEQUErRDtnQkFDL0QsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLFVBQTJCLENBQUM7Z0JBQ3BELElBQUksZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQkFDekMsT0FBTyxJQUFJLENBQUM7aUJBQ2I7Z0JBQ0QsTUFBTTtZQUNSO2dCQUNFLE1BQU07U0FDVDtRQUNELE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVELFNBQVMsd0JBQXdCLENBQUMsSUFBdUIsRUFBRSxFQUFrQjtRQUMzRSxJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUMsbUJBQW1CLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3JELElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRTtZQUN4QixPQUFPLEtBQUssQ0FBQztTQUNkO1FBRUQsSUFBSSxPQUFPLENBQUMsZUFBZSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQ3pELE1BQU0sR0FBRyxFQUFFLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLENBQUM7U0FDdEM7UUFFRCxLQUFLLE1BQU0sWUFBWSxJQUFJLE1BQU0sQ0FBQyxZQUFZLEVBQUUsRUFBRTtZQUNoRCxJQUFJLFlBQVksQ0FBQyxJQUFJLEtBQUssa0JBQWtCLEVBQUU7Z0JBQzVDLE9BQU8sSUFBSSxDQUFDO2FBQ2I7U0FDRjtRQUNELE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIlxuXG4vKipcbiAqIEBmaWxlb3ZlcnZpZXcgQSBUc2V0c2UgcnVsZSB0aGF0IGNoZWNrcyB0aGUgcmV0dXJuIHZhbHVlIG9mIGNlcnRhaW4gZnVuY3Rpb25zXG4gKiBtdXN0IGJlIHVzZWQuXG4gKi9cblxuaW1wb3J0ICogYXMgdHN1dGlscyBmcm9tICd0c3V0aWxzJztcbmltcG9ydCAqIGFzIHRzIGZyb20gJ3R5cGVzY3JpcHQnO1xuXG5pbXBvcnQge0NoZWNrZXJ9IGZyb20gJy4uL2NoZWNrZXInO1xuaW1wb3J0IHtFcnJvckNvZGV9IGZyb20gJy4uL2Vycm9yX2NvZGUnO1xuaW1wb3J0IHtBYnN0cmFjdFJ1bGV9IGZyb20gJy4uL3J1bGUnO1xuXG5jb25zdCBGQUlMVVJFX1NUUklORyA9ICdyZXR1cm4gdmFsdWUgaXMgdW51c2VkLidcbiAgICArICdcXG5cXHRTZWUgaHR0cDovL3RzZXRzZS5pbmZvL2NoZWNrLXJldHVybi12YWx1ZSc7XG5cbi8vIEEgbGlzdCBvZiB3ZWxsLWtub3duIGZ1bmN0aW9ucyB0aGF0IHRoZSByZXR1cm4gdmFsdWUgbXVzdCBiZSB1c2VkLiBJZiB1bnVzZWRcbi8vIHRoZW4gdGhlIGZ1bmN0aW9uIGNhbGwgaXMgZWl0aGVyIGEgbm8tb3AgKGUuZy4gJ2Zvby50cmltKCknIGZvbyBpcyB1bmNoYW5nZWQpXG4vLyBvciBjYW4gYmUgcmVwbGFjZWQgYnkgYW5vdGhlciAoQXJyYXkubWFwKCkgc2hvdWxkIGJlIHJlcGxhY2VkIHdpdGggYSBsb29wIG9yXG4vLyBBcnJheS5mb3JFYWNoKCkgaWYgdGhlIHJldHVybiB2YWx1ZSBpcyB1bnVzZWQpLlxuY29uc3QgTUVUSE9EU19UT19DSEVDSyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gIFsnQXJyYXknLCAnY29uY2F0J10sXG4gIFsnQXJyYXknLCAnZmlsdGVyJ10sXG4gIFsnQXJyYXknLCAnbWFwJ10sXG4gIFsnQXJyYXknLCAnc2xpY2UnXSxcbiAgWydGdW5jdGlvbicsICdiaW5kJ10sXG4gIFsnT2JqZWN0JywgJ2NyZWF0ZSddLFxuICBbJ3N0cmluZycsICdjb25jYXQnXSxcbiAgWydzdHJpbmcnLCAnbm9ybWFsaXplJ10sXG4gIFsnc3RyaW5nJywgJ3BhZFN0YXJ0J10sXG4gIFsnc3RyaW5nJywgJ3BhZEVuZCddLFxuICBbJ3N0cmluZycsICdyZXBlYXQnXSxcbiAgWydzdHJpbmcnLCAnc2xpY2UnXSxcbiAgWydzdHJpbmcnLCAnc3BsaXQnXSxcbiAgWydzdHJpbmcnLCAnc3Vic3RyJ10sXG4gIFsnc3RyaW5nJywgJ3N1YnN0cmluZyddLFxuICBbJ3N0cmluZycsICd0b0xvY2FsZUxvd2VyQ2FzZSddLFxuICBbJ3N0cmluZycsICd0b0xvY2FsZVVwcGVyQ2FzZSddLFxuICBbJ3N0cmluZycsICd0b0xvd2VyQ2FzZSddLFxuICBbJ3N0cmluZycsICd0b1VwcGVyQ2FzZSddLFxuICBbJ3N0cmluZycsICd0cmltJ10sXG5dLm1hcChsaXN0ID0+IGxpc3Quam9pbignIycpKSk7XG5cbmV4cG9ydCBjbGFzcyBSdWxlIGV4dGVuZHMgQWJzdHJhY3RSdWxlIHtcbiAgcmVhZG9ubHkgcnVsZU5hbWUgPSAnY2hlY2stcmV0dXJuLXZhbHVlJztcbiAgcmVhZG9ubHkgY29kZSA9IEVycm9yQ29kZS5DSEVDS19SRVRVUk5fVkFMVUU7XG5cbiAgLy8gcmVnaXN0ZXJzIGNoZWNrQ2FsbEV4cHJlc3Npb24oKSBmdW5jdGlvbiBvbiB0cy5DYWxsRXhwcmVzc2lvbiBub2RlLlxuICAvLyBUeXBlU2NyaXB0IGNvbmZvcm1hbmNlIHdpbGwgdHJhdmVyc2UgdGhlIEFTVCBvZiBlYWNoIHNvdXJjZSBmaWxlIGFuZCBydW5cbiAgLy8gY2hlY2tDYWxsRXhwcmVzc2lvbigpIGV2ZXJ5IHRpbWUgaXQgZW5jb3VudGVycyBhIHRzLkNhbGxFeHByZXNzaW9uIG5vZGUuXG4gIHJlZ2lzdGVyKGNoZWNrZXI6IENoZWNrZXIpIHtcbiAgICBjaGVja2VyLm9uKHRzLlN5bnRheEtpbmQuQ2FsbEV4cHJlc3Npb24sIGNoZWNrQ2FsbEV4cHJlc3Npb24sIHRoaXMuY29kZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2hlY2tDYWxsRXhwcmVzc2lvbihjaGVja2VyOiBDaGVja2VyLCBub2RlOiB0cy5DYWxsRXhwcmVzc2lvbikge1xuICAvLyBTaG9ydC1jaXJjdWl0IGJlZm9yZSB1c2luZyB0aGUgdHlwZWNoZWNrZXIgaWYgcG9zc2libGUsIGFzIGl0cyBleHBlbnNpdmUuXG4gIC8vIFdvcmthcm91bmQgZm9yIGh0dHBzOi8vZ2l0aHViLmNvbS9NaWNyb3NvZnQvVHlwZVNjcmlwdC9pc3N1ZXMvMjc5OTdcbiAgaWYgKHRzdXRpbHMuaXNFeHByZXNzaW9uVmFsdWVVc2VkKG5vZGUpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2hlY2sgaWYgdGhpcyBDYWxsRXhwcmVzc2lvbiBpcyBvbmUgb2YgdGhlIHdlbGwta25vd24gZnVuY3Rpb25zIGFuZCByZXR1cm5zXG4gIC8vIGEgbm9uLXZvaWQgdmFsdWUgdGhhdCBpcyB1bnVzZWQuXG4gIGNvbnN0IHNpZ25hdHVyZSA9IGNoZWNrZXIudHlwZUNoZWNrZXIuZ2V0UmVzb2x2ZWRTaWduYXR1cmUobm9kZSk7XG4gIGlmIChzaWduYXR1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJldHVyblR5cGUgPSBjaGVja2VyLnR5cGVDaGVja2VyLmdldFJldHVyblR5cGVPZlNpZ25hdHVyZShzaWduYXR1cmUpO1xuICAgIGlmICghIShyZXR1cm5UeXBlLmZsYWdzICYgdHMuVHlwZUZsYWdzLlZvaWQpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIEFsdGhvdWdoIGhhc0NoZWNrUmV0dXJuVmFsdWVKc0RvYygpIGlzIGZhc3RlciB0aGFuIGlzQmxhY2tMaXN0ZWQoKSwgaXRcbiAgICAvLyByZXR1cm5zIGZhbHNlIG1vc3Qgb2YgdGhlIHRpbWUgYW5kIHRodXMgaXNCbGFja0xpc3RlZCgpIHdvdWxkIGhhdmUgdG8gcnVuXG4gICAgLy8gYW55d2F5LiBUaGVyZWZvcmUgd2Ugc2hvcnQtY2lyY3VpdCBoYXNDaGVja1JldHVyblZhbHVlSnNEb2MoKS5cbiAgICBpZiAoIWlzQmxhY2tMaXN0ZWQobm9kZSwgY2hlY2tlci50eXBlQ2hlY2tlcikgJiZcbiAgICAgICAgIWhhc0NoZWNrUmV0dXJuVmFsdWVKc0RvYyhub2RlLCBjaGVja2VyLnR5cGVDaGVja2VyKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNoZWNrZXIuYWRkRmFpbHVyZUF0Tm9kZShub2RlLCBGQUlMVVJFX1NUUklORyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNCbGFja0xpc3RlZChub2RlOiB0cy5DYWxsRXhwcmVzc2lvbiwgdGM6IHRzLlR5cGVDaGVja2VyKTogYm9vbGVhbiB7XG4gIHR5cGUgQWNjZXNzRXhwcmVzc2lvbiA9XG4gICAgICB0cy5Qcm9wZXJ0eUFjY2Vzc0V4cHJlc3Npb258dHMuRWxlbWVudEFjY2Vzc0V4cHJlc3Npb247XG4gIHN3aXRjaCAobm9kZS5leHByZXNzaW9uLmtpbmQpIHtcbiAgICBjYXNlIHRzLlN5bnRheEtpbmQuUHJvcGVydHlBY2Nlc3NFeHByZXNzaW9uOlxuICAgIGNhc2UgdHMuU3ludGF4S2luZC5FbGVtZW50QWNjZXNzRXhwcmVzc2lvbjpcbiAgICAgIC8vIEV4YW1wbGU6IGZvby5iYXIoKSBvciBmb29bYmFyXSgpXG4gICAgICAvLyBleHByZXNzaW9uTm9kZSBpcyBmb29cbiAgICAgIGNvbnN0IG5vZGVFeHByZXNzaW9uID0gKG5vZGUuZXhwcmVzc2lvbiBhcyBBY2Nlc3NFeHByZXNzaW9uKS5leHByZXNzaW9uO1xuICAgICAgY29uc3Qgbm9kZUV4cHJlc3Npb25TdHJpbmcgPSBub2RlRXhwcmVzc2lvbi5nZXRUZXh0KCk7XG4gICAgICBjb25zdCBub2RlVHlwZSA9IHRjLmdldFR5cGVBdExvY2F0aW9uKG5vZGVFeHByZXNzaW9uKTtcblxuICAgICAgLy8gbm9kZVR5cGVTdHJpbmcgaXMgdGhlIHN0cmluZyByZXByZXNlbnRhdGlvbiBvZiB0aGUgdHlwZSBvZiBmb29cbiAgICAgIGxldCBub2RlVHlwZVN0cmluZyA9IHRjLnR5cGVUb1N0cmluZyhub2RlVHlwZSk7XG4gICAgICBpZiAobm9kZVR5cGVTdHJpbmcuZW5kc1dpdGgoJ1tdJykpIHtcbiAgICAgICAgbm9kZVR5cGVTdHJpbmcgPSAnQXJyYXknO1xuICAgICAgfVxuICAgICAgaWYgKG5vZGVUeXBlU3RyaW5nID09PSAnT2JqZWN0Q29uc3RydWN0b3InKSB7XG4gICAgICAgIG5vZGVUeXBlU3RyaW5nID0gJ09iamVjdCc7XG4gICAgICB9XG4gICAgICBpZiAodHN1dGlscy5pc1R5cGVGbGFnU2V0KG5vZGVUeXBlLCB0cy5UeXBlRmxhZ3MuU3RyaW5nTGl0ZXJhbCkpIHtcbiAgICAgICAgbm9kZVR5cGVTdHJpbmcgPSAnc3RyaW5nJztcbiAgICAgIH1cblxuICAgICAgLy8gbm9kZUZ1bmN0aW9uIGlzIGJhclxuICAgICAgbGV0IG5vZGVGdW5jdGlvbiA9ICcnO1xuICAgICAgaWYgKHRzdXRpbHMuaXNQcm9wZXJ0eUFjY2Vzc0V4cHJlc3Npb24obm9kZS5leHByZXNzaW9uKSkge1xuICAgICAgICBub2RlRnVuY3Rpb24gPSBub2RlLmV4cHJlc3Npb24ubmFtZS5nZXRUZXh0KCk7XG4gICAgICB9XG4gICAgICBpZiAodHN1dGlscy5pc0VsZW1lbnRBY2Nlc3NFeHByZXNzaW9uKG5vZGUuZXhwcmVzc2lvbikpIHtcbiAgICAgICAgY29uc3QgYXJndW1lbnQgPSBub2RlLmV4cHJlc3Npb24uYXJndW1lbnRFeHByZXNzaW9uO1xuICAgICAgICBpZiAoYXJndW1lbnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIG5vZGVGdW5jdGlvbiA9IGFyZ3VtZW50LmdldFRleHQoKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBpZiAnZm9vI2Jhcicgb3IgYCR7dHlwZW9mIGZvb30jYmFyYCBpcyBpbiB0aGUgYmxhY2tsaXN0LlxuICAgICAgaWYgKE1FVEhPRFNfVE9fQ0hFQ0suaGFzKGAke25vZGVUeXBlU3RyaW5nfSMke25vZGVGdW5jdGlvbn1gKSB8fFxuICAgICAgICAgIE1FVEhPRFNfVE9fQ0hFQ0suaGFzKGAke25vZGVFeHByZXNzaW9uU3RyaW5nfSMke25vZGVGdW5jdGlvbn1gKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgLy8gRm9yICdzdHIucmVwbGFjZShyZWdleHB8c3Vic3RyLCBuZXdTdWJzdHJ8ZnVuY3Rpb24pJyBvbmx5IGNoZWNrIHdoZW5cbiAgICAgIC8vIHRoZSBzZWNvbmQgcGFyYW1ldGVyIGlzICduZXdTdWJzdHInLlxuICAgICAgaWYgKChgJHtub2RlVHlwZVN0cmluZ30jJHtub2RlRnVuY3Rpb259YCA9PT0gJ3N0cmluZyNyZXBsYWNlJykgfHxcbiAgICAgICAgICAoYCR7bm9kZUV4cHJlc3Npb25TdHJpbmd9IyR7bm9kZUZ1bmN0aW9ufWAgPT09ICdzdHJpbmcjcmVwbGFjZScpKSB7XG4gICAgICAgIHJldHVybiBub2RlLmFyZ3VtZW50cy5sZW5ndGggPT09IDIgJiZcbiAgICAgICAgICAgICF0c3V0aWxzLmlzRnVuY3Rpb25XaXRoQm9keShub2RlLmFyZ3VtZW50c1sxXSk7XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICBjYXNlIHRzLlN5bnRheEtpbmQuSWRlbnRpZmllcjpcbiAgICAgIC8vIEV4YW1wbGU6IGZvbygpXG4gICAgICAvLyBXZSBjdXJyZW50bHkgZG9uJ3QgaGF2ZSBmdW5jdGlvbnMgb2YgdGhpcyBraW5kIGluIGJsYWNrbGlzdC5cbiAgICAgIGNvbnN0IGlkZW50aWZpZXIgPSBub2RlLmV4cHJlc3Npb24gYXMgdHMuSWRlbnRpZmllcjtcbiAgICAgIGlmIChNRVRIT0RTX1RPX0NIRUNLLmhhcyhpZGVudGlmaWVyLnRleHQpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIGJyZWFrO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gaGFzQ2hlY2tSZXR1cm5WYWx1ZUpzRG9jKG5vZGU6IHRzLkNhbGxFeHByZXNzaW9uLCB0YzogdHMuVHlwZUNoZWNrZXIpIHtcbiAgbGV0IHN5bWJvbCA9IHRjLmdldFN5bWJvbEF0TG9jYXRpb24obm9kZS5leHByZXNzaW9uKTtcbiAgaWYgKHN5bWJvbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKHRzdXRpbHMuaXNTeW1ib2xGbGFnU2V0KHN5bWJvbCwgdHMuU3ltYm9sRmxhZ3MuQWxpYXMpKSB7XG4gICAgc3ltYm9sID0gdGMuZ2V0QWxpYXNlZFN5bWJvbChzeW1ib2wpO1xuICB9XG5cbiAgZm9yIChjb25zdCBqc0RvY1RhZ0luZm8gb2Ygc3ltYm9sLmdldEpzRG9jVGFncygpKSB7XG4gICAgaWYgKGpzRG9jVGFnSW5mby5uYW1lID09PSAnY2hlY2tSZXR1cm5WYWx1ZScpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG4iXX0=