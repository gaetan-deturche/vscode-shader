'use strict';

import { CompletionItem, CompletionItemKind } from 'vscode';
import { Scope, TypeRef, StructDecl, SourceFile, VECTOR_TYPES, KNOWN_RESOURCE_TYPES } from './nodes';
import { resolve, findStructInFile } from './scope';

/** Looks up struct/typedef declarations across the workspace (implemented by AstIndex). */
export interface TypeProvider {
    findStruct(name: string): StructDecl | undefined;
    resolveTypedef(name: string): TypeRef | undefined;
}

interface Segment {
    name: string;
    isCall: boolean;
    indexCount: number;
}

function isIdentPart(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * Parse the member-access chain that ends at the cursor (text is the line up
 * to, but excluding, the trailing `.`). Returns segments left-to-right, or null.
 */
export function parseAccessChain(text: string): Segment[] | null {
    const segments: Segment[] = [];
    let j = text.length;

    const skipWs = () => { while (j > 0 && /\s/.test(text[j - 1])) { j--; } };
    const matchBack = (open: string, close: string): boolean => {
        if (text[j - 1] !== close) { return false; }
        let depth = 0;
        while (j > 0) {
            const c = text[j - 1];
            if (c === close) { depth++; }
            else if (c === open) { depth--; if (depth === 0) { j--; return true; } }
            j--;
        }
        return true;
    };

    for (;;) {
        skipWs();
        let isCall = false;
        let indexCount = 0;
        // trailing suffixes belonging to the next identifier
        for (;;) {
            skipWs();
            if (text[j - 1] === ']') { if (matchBack('[', ']')) { indexCount++; continue; } }
            if (text[j - 1] === ')') { if (matchBack('(', ')')) { isCall = true; continue; } }
            break;
        }
        skipWs();
        // read identifier backwards
        let end = j;
        while (j > 0 && isIdentPart(text[j - 1])) { j--; }
        const name = text.slice(j, end);
        if (!name || /^[0-9]/.test(name)) { return segments.length ? segments : null; }
        segments.unshift({ name, isCall, indexCount });
        skipWs();
        if (j > 0 && text[j - 1] === '.') { j--; continue; }
        break;
    }
    return segments.length ? segments : null;
}

/** Resolve the type produced by an access chain. */
export function resolveChainType(segments: Segment[], scope: Scope | null, file: SourceFile, provider: TypeProvider): TypeRef | null {
    if (segments.length === 0) { return null; }

    // base
    const base = segments[0];
    const entry = resolve(scope, base.name);
    if (!entry || !entry.type) { return null; }
    let type: TypeRef | null = peelIndex(entry.type, base.indexCount);

    for (let k = 1; k < segments.length && type; k++) {
        const seg = segments[k];
        const struct = structForType(type, file, provider);
        if (!struct) { return null; }
        const field = struct.fields.find(f => f.name === seg.name);
        if (!field) { return null; }
        type = peelIndex(field.type, seg.indexCount);
    }
    return type;
}

/** The completion items for the members of a resolved type. */
export function membersOfType(type: TypeRef, file: SourceFile, provider: TypeProvider, swizzle: boolean): CompletionItem[] {
    const items: CompletionItem[] = [];

    // Vector swizzles (only when not an array reference).
    if (swizzle && (!type.arrayDims || type.arrayDims === 0)) {
        const comps = VECTOR_TYPES[type.name];
        if (comps) {
            for (const set of [['x', 'y', 'z', 'w'], ['r', 'g', 'b', 'a']]) {
                for (let n = 0; n < comps; n++) {
                    const it = new CompletionItem(set[n], CompletionItemKind.Field);
                    it.detail = '(swizzle)';
                    items.push(it);
                }
            }
            return items;
        }
    }

    const struct = structForType(type, file, provider);
    if (struct) {
        for (const f of struct.fields) {
            const it = new CompletionItem(f.name, CompletionItemKind.Field);
            it.detail = `${typeRefToString(f.type)} ${f.name}`;
            items.push(it);
        }
    }
    return items;
}

/** Resolve a type reference down to a struct declaration, unwrapping typedefs and templated containers. */
function structForType(type: TypeRef, file: SourceFile, provider: TypeProvider): StructDecl | undefined {
    let name = type.name;
    let args = type.args;

    // Unwrap templated containers (ConstantBuffer<T>, StructuredBuffer<T>, ...) to their element type.
    if (KNOWN_RESOURCE_TYPES.has(name) && args && args.length > 0) {
        name = args[0].name;
        args = args[0].args;
    }

    // Follow typedefs (one level is enough for the common case; guard against cycles).
    for (let i = 0; i < 8; i++) {
        const td = provider.resolveTypedef(name);
        if (!td || td.name === name) { break; }
        name = td.name;
    }

    return findStructInFile(file, name) || provider.findStruct(name);
}

function peelIndex(type: TypeRef, count: number): TypeRef {
    if (count <= 0) { return type; }
    let t = type;
    for (let i = 0; i < count; i++) {
        if (t.arrayDims && t.arrayDims > 0) {
            t = { name: t.name, args: t.args, arrayDims: t.arrayDims - 1 };
        } else if (KNOWN_RESOURCE_TYPES.has(t.name) && t.args && t.args.length > 0) {
            t = t.args[0];
        } else {
            break;
        }
    }
    return t;
}

export function typeRefToString(type: TypeRef): string {
    let s = type.name;
    if (type.args && type.args.length > 0) {
        s += '<' + type.args.map(typeRefToString).join(', ') + '>';
    }
    if (type.arrayDims && type.arrayDims > 0) {
        s += '[]'.repeat(type.arrayDims);
    }
    return s;
}
