'use strict';

import { Scope, SymbolEntry, SourceFile, StructDecl, Decl } from './nodes';

/** The deepest scope whose span contains `offset`, starting from a file. */
export function scopeAtOffset(file: SourceFile, offset: number): Scope {
    let current = file.scope;
    let advanced = true;
    while (advanced) {
        advanced = false;
        for (const child of current.children) {
            if (offset >= child.span.start && offset <= child.span.end) {
                current = child;
                advanced = true;
                break;
            }
        }
    }
    return current;
}

/** Resolve a name by walking from `scope` up through parents; nearest declaration wins. */
export function resolve(scope: Scope | null, name: string): SymbolEntry | undefined {
    let s = scope;
    while (s) {
        const entries = s.symbols.get(name);
        if (entries && entries.length > 0) {
            return entries[entries.length - 1];
        }
        s = s.parent;
    }
    return undefined;
}

/** All entries matching a name across the scope chain (e.g. for overloads). */
export function resolveAll(scope: Scope | null, name: string): SymbolEntry[] {
    const out: SymbolEntry[] = [];
    let s = scope;
    while (s) {
        const entries = s.symbols.get(name);
        if (entries) { out.push(...entries); }
        s = s.parent;
    }
    return out;
}

/** Find a struct/class declaration by name within a single file's top-level decls. */
export function findStructInFile(file: SourceFile, name: string): StructDecl | undefined {
    return findStructInDecls(file.decls, name);
}

function findStructInDecls(decls: Decl[], name: string): StructDecl | undefined {
    for (const d of decls) {
        if (d.kind === 'StructDecl' && d.name === name) { return d; }
        if (d.kind === 'NamespaceDecl') {
            const found = findStructInDecls(d.decls, name);
            if (found) { return found; }
        }
    }
    return undefined;
}
