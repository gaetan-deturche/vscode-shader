'use strict';

import { SymbolInformation, TextDocument, Position, Location, CompletionItem, Hover, SignatureHelp } from 'vscode';

/**
 * Common contract implemented by both the regex/ripgrep backend (SymbolCache)
 * and the AST backend (AstIndex). Providers depend on this interface so they
 * never have to branch on which backend is active.
 *
 * The required methods mirror the surface the providers already used on
 * SymbolCache. The optional methods are AST-only richer capabilities; on the
 * regex backend they are `undefined` and providers gracefully fall back to
 * their existing behaviour.
 */
export interface ISymbolBackend {
    /** Symbols declared in a single document. */
    getDocumentSymbols(document: TextDocument): Promise<SymbolInformation[]>;

    /** First workspace/document symbol matching `name` exactly, or null. */
    findSymbol(name: string, document?: TextDocument): Promise<SymbolInformation | null>;

    /** All symbols matching `name` exactly. Pass "" to get every symbol. */
    findSymbols(name: string): Promise<SymbolInformation[]>;

    /** Workspace symbols filtered by a (possibly empty) query string. */
    provideWorkspaceSymbols(query: string): Promise<SymbolInformation[]>;

    /** Rebuild the workspace symbol index, showing progress. `force` re-runs heavier scans (e.g. C++). */
    refreshWithProgress(force?: boolean): Promise<void>;

    dispose(): void;

    // --- Optional AST-only capabilities ---------------------------------

    /** Scope-aware go-to-definition. */
    resolveDefinition?(document: TextDocument, position: Position): Promise<Location[] | null>;

    /** Member completion after a `.` (struct fields, swizzles, ...). */
    completeMembers?(document: TextDocument, position: Position): Promise<CompletionItem[] | null>;

    /** Typed declaration/signature hover. */
    describeSymbol?(document: TextDocument, position: Position): Promise<Hover | null>;

    /** Signature help built from a parsed function declaration. */
    getSignature?(document: TextDocument, position: Position): Promise<SignatureHelp | null>;
}
