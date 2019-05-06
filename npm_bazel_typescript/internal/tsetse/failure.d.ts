import * as ts from 'typescript';
/**
 * A Tsetse check Failure is almost identical to a Diagnostic from TypeScript
 * except that:
 * (1) The error code is defined by each individual Tsetse rule.
 * (2) The optional `source` property is set to `Tsetse` so the host (VS Code
 * for instance) would use that to indicate where the error comes from.
 * (3) There's an optional suggestedFix field.
 */
export declare class Failure {
    private readonly sourceFile;
    private readonly start;
    private readonly end;
    private readonly failureText;
    private readonly code;
    private readonly suggestedFix?;
    constructor(sourceFile: ts.SourceFile, start: number, end: number, failureText: string, code: number, suggestedFix?: Fix | undefined);
    /**
     * This returns a structure compatible with ts.Diagnostic, but with added
     * fields, for convenience and to support suggested fixes.
     */
    toDiagnostic(): ts.Diagnostic & {
        end: number;
        fix?: Fix;
    };
}
/**
 * A Fix is a potential repair to the associated Failure.
 */
export interface Fix {
    /**
     * The individual text replacements composing that fix.
     */
    changes: IndividualChange[];
}
export interface IndividualChange {
    sourceFile: ts.SourceFile;
    start: number;
    end: number;
    replacement: string;
}
