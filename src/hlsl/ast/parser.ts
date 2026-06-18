'use strict';

import { SymbolKind } from 'vscode';
import { Lexer, Token, TokenKind } from './lexer';
import {
    SourceFile, Decl, Scope, SymbolEntry, NodeSpan, TypeRef, ParseError,
    StructDecl, FieldDecl, VariableDecl, CBufferDecl, ResourceDecl, FunctionDecl,
    ParamDecl, TypedefDecl, NamespaceDecl, MacroDecl, IncludeDecl, Attribute,
    KNOWN_RESOURCE_TYPES,
} from './nodes';

const MODIFIERS = new Set<string>([
    'static', 'const', 'uniform', 'extern', 'shared', 'groupshared', 'globallycoherent',
    'volatile', 'precise', 'inline', 'row_major', 'column_major', 'snorm', 'unorm',
    'centroid', 'nointerpolation', 'noperspective', 'sample', 'linear',
]);

const CONTROL_KEYWORDS = new Set<string>([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'discard',
]);

/** Parse HLSL source into a SourceFile AST. Always returns a result, even on error. */
export function parse(source: string, uri: string): SourceFile {
    return new Parser(source, uri).parseSourceFile();
}

class Parser {
    private tokens: Token[];
    private i = 0;
    private lexer: Lexer;
    private uri: string;
    private errors: ParseError[] = [];
    private includes: IncludeDecl[] = [];

    constructor(source: string, uri: string) {
        this.lexer = new Lexer(source);
        this.tokens = this.lexer.tokenize();
        this.uri = uri;
    }

    // --- token helpers ---------------------------------------------------

    private peek(offset = 0): Token { return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)]; }
    private cur(): Token { return this.tokens[this.i]; }
    private atEnd(): boolean { return this.cur().kind === TokenKind.EndOfFile; }
    private next(): Token { return this.tokens[this.i++]; }
    private isPunct(v: string, offset = 0): boolean { const t = this.peek(offset); return t.kind === TokenKind.Punct && t.value === v; }
    private isIdent(v?: string, offset = 0): boolean {
        const t = this.peek(offset);
        return t.kind === TokenKind.Identifier && (v === undefined || t.value === v);
    }
    private error(message: string, span: NodeSpan): void { this.errors.push({ message, span }); }

    // --- entry -----------------------------------------------------------

    public parseSourceFile(): SourceFile {
        const fileEnd = this.lexer.source.length;
        const scope: Scope = newScope(null, { start: 0, end: fileEnd });
        const decls = this.parseDeclList(scope, /*topLevel*/ true, undefined);
        return {
            kind: 'SourceFile',
            uri: this.uri,
            decls,
            scope,
            includes: this.includes,
            errors: this.errors,
            lineStarts: this.lexer.lineStarts,
            span: { start: 0, end: this.tokens.length ? this.tokens[this.tokens.length - 1].end : 0 },
        };
    }

    /** Parse declarations until EOF (topLevel) or a closing `}`. */
    private parseDeclList(scope: Scope, topLevel: boolean, containerName: string | undefined): Decl[] {
        const decls: Decl[] = [];
        let guard = 0;
        while (!this.atEnd()) {
            if (!topLevel && this.isPunct('}')) { break; }
            const startI = this.i;

            const parsed = this.parseTopDecl(scope, containerName);
            for (const d of parsed) { decls.push(d); }

            // Forward progress guard against pathological inputs.
            if (this.i === startI) {
                this.next();
            }
            if (++guard > 2_000_000) { break; }
        }
        return decls;
    }

    private parseTopDecl(scope: Scope, containerName: string | undefined): Decl[] {
        const t = this.cur();

        if (t.kind === TokenKind.Preprocessor) {
            this.next();
            const d = this.parsePreprocessor(t, scope);
            return d ? [d] : [];
        }

        // Stray punctuation / separators.
        if (t.kind === TokenKind.Punct) {
            if (t.value === ';') { this.next(); return []; }
            if (t.value === '[') {
                // Attributes preceding a declaration.
                const attrs = this.parseAttributes();
                return this.parseDeclarationOrFunction(scope, containerName, attrs);
            }
            // Unknown punctuation: skip.
            this.next();
            return [];
        }

        if (t.kind === TokenKind.Identifier) {
            switch (t.value) {
                case 'struct':
                case 'class': {
                    const d = this.parseStruct(scope, containerName);
                    return d ? [d] : [];
                }
                case 'cbuffer':
                case 'tbuffer': {
                    const d = this.parseCBuffer(scope, containerName);
                    return d ? [d] : [];
                }
                case 'ConstantBuffer':
                    return this.parseDeclarationOrFunction(scope, containerName, []);
                case 'typedef': {
                    const d = this.parseTypedef(scope, containerName);
                    return d ? [d] : [];
                }
                case 'namespace': {
                    const d = this.parseNamespace(scope, containerName);
                    return d ? [d] : [];
                }
                default:
                    return this.parseDeclarationOrFunction(scope, containerName, []);
            }
        }

        // Numbers / strings at top level: skip.
        this.next();
        return [];
    }

    // --- preprocessor ----------------------------------------------------

    private parsePreprocessor(t: Token, scope: Scope): Decl | null {
        const text = t.value.trim();
        // #include "..." or #include <...>
        let m = /^#\s*include\s*(["<])([^">]+)[">]/.exec(text);
        if (m) {
            const inc: IncludeDecl = { kind: 'IncludeDecl', path: m[2], angle: m[1] === '<', span: { start: t.start, end: t.end } };
            this.includes.push(inc);
            return inc;
        }
        // #define NAME(args) body   |   #define NAME body
        m = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?/.exec(text);
        if (m) {
            const name = m[1];
            const isFunc = m[2] !== undefined;
            const params = isFunc ? m[3].split(',').map(s => s.trim()).filter(s => s.length > 0) : undefined;
            const body = text.slice(m[0].length).trim();
            // Position the name span at the macro name within the directive.
            const nameOffset = t.start + t.value.indexOf(name, t.value.indexOf('define') + 6);
            const decl: MacroDecl = {
                kind: 'MacroDecl', name, params, body,
                nameSpan: { start: nameOffset, end: nameOffset + name.length },
                span: { start: t.start, end: t.end },
            };
            addSymbol(scope, name, decl, isFunc ? SymbolKind.Function : SymbolKind.Constant);
            return decl;
        }
        return null;
    }

    // --- struct / class --------------------------------------------------

    private parseStruct(scope: Scope, containerName: string | undefined): StructDecl | null {
        const kw = this.next(); // struct|class
        const isClass = kw.value === 'class';
        let name = '';
        let nameSpan: NodeSpan = { start: kw.start, end: kw.end };
        if (this.isIdent()) {
            const nt = this.next();
            name = nt.value;
            nameSpan = { start: nt.start, end: nt.end };
        }
        let base: string | undefined;
        if (this.isPunct(':')) {
            this.next();
            // optional access specifier then base name
            if (this.isIdent('public') || this.isIdent('private') || this.isIdent('protected')) { this.next(); }
            if (this.isIdent()) { base = this.next().value; }
        }

        const fields: FieldDecl[] = [];
        if (this.isPunct('{')) {
            this.next();
            while (!this.atEnd() && !this.isPunct('}')) {
                const before = this.i;
                this.parseStructMember(fields);
                if (this.i === before) { this.next(); }
            }
            if (this.isPunct('}')) { this.next(); }
        }
        // trailing `;` (and possibly a variable instance name — ignored)
        this.skipToSemicolon();

        const decl: StructDecl = {
            kind: 'StructDecl', name, nameSpan, isClass, base, fields, containerName,
            span: { start: kw.start, end: this.prevEnd() },
        };
        if (name) { addSymbol(scope, name, decl, isClass ? SymbolKind.Class : SymbolKind.Struct, { name }); }
        return decl;
    }

    private parseStructMember(fields: FieldDecl[]): void {
        if (this.isPunct(';')) { this.next(); return; }
        // Methods inside structs: type name ( ... ) { } -> skip body, ignore for fields.
        const modsAndType = this.tryParseModifiersAndType();
        if (!modsAndType) { this.skipToSemicolon(); return; }
        const { type } = modsAndType;

        // one or more declarators
        do {
            if (!this.isIdent()) { break; }
            const nt = this.next();
            const fieldType = this.applyArraySuffix(type);
            if (this.isPunct('(')) {
                // method - skip params + optional body
                this.skipBalanced('(', ')');
                if (this.isPunct('{')) { this.skipBalanced('{', '}'); }
                this.skipToSemicolon();
                return;
            }
            let semantic: string | undefined;
            if (this.isPunct(':')) {
                this.next();
                if (this.isIdent()) { semantic = this.next().value; }
                // skip register/packoffset(...)
                if (this.isPunct('(')) { this.skipBalanced('(', ')'); }
            }
            // skip initializer
            if (this.isPunct('=')) { this.skipUntilCommaOrSemicolon(); }
            fields.push({
                kind: 'FieldDecl', name: nt.value, nameSpan: { start: nt.start, end: nt.end },
                type: fieldType, semantic, span: { start: nt.start, end: nt.end },
            });
        } while (this.matchPunct(','));
        this.skipToSemicolon();
    }

    // --- cbuffer / tbuffer ----------------------------------------------

    private parseCBuffer(scope: Scope, containerName: string | undefined): CBufferDecl | null {
        const kw = this.next();
        let name = '';
        let nameSpan: NodeSpan = { start: kw.start, end: kw.end };
        if (this.isIdent()) { const nt = this.next(); name = nt.value; nameSpan = { start: nt.start, end: nt.end }; }
        let register: string | undefined;
        if (this.isPunct(':')) {
            this.next();
            register = this.readRegisterLike();
        }
        const fields: VariableDecl[] = [];
        if (this.isPunct('{')) {
            this.next();
            while (!this.atEnd() && !this.isPunct('}')) {
                const before = this.i;
                this.parseCBufferMember(fields, name, scope);
                if (this.i === before) { this.next(); }
            }
            if (this.isPunct('}')) { this.next(); }
        }
        this.skipToSemicolon();
        const decl: CBufferDecl = {
            kind: 'CBufferDecl', bufferKind: kw.value as 'cbuffer' | 'tbuffer', name, nameSpan, register, fields,
            span: { start: kw.start, end: this.prevEnd() },
        };
        if (name) { addSymbol(scope, name, decl, SymbolKind.Struct); }
        return decl;
    }

    private parseCBufferMember(fields: VariableDecl[], bufferName: string, scope: Scope): void {
        if (this.isPunct(';')) { this.next(); return; }
        const v = this.tryParseVariableDecls(bufferName);
        for (const decl of v) {
            fields.push(decl);
            // cbuffer members are globally visible in HLSL
            addSymbol(scope, decl.name, decl, SymbolKind.Variable, decl.type);
        }
        if (v.length === 0) { this.skipToSemicolon(); }
    }

    // --- typedef ---------------------------------------------------------

    private parseTypedef(scope: Scope, containerName: string | undefined): TypedefDecl | null {
        const kw = this.next();
        const underlying = this.parseType();
        if (!underlying || !this.isIdent()) { this.skipToSemicolon(); return null; }
        const nt = this.next();
        const decl: TypedefDecl = {
            kind: 'TypedefDecl', name: nt.value, nameSpan: { start: nt.start, end: nt.end }, underlying,
            span: { start: kw.start, end: nt.end },
        };
        this.skipToSemicolon();
        addSymbol(scope, decl.name, decl, SymbolKind.TypeParameter, underlying);
        return decl;
    }

    // --- namespace -------------------------------------------------------

    private parseNamespace(scope: Scope, containerName: string | undefined): NamespaceDecl | null {
        const kw = this.next();
        let name = '';
        let nameSpan: NodeSpan = { start: kw.start, end: kw.end };
        if (this.isIdent()) { const nt = this.next(); name = nt.value; nameSpan = { start: nt.start, end: nt.end }; }
        const inner = containerName ? `${containerName}::${name}` : name;
        let decls: Decl[] = [];
        if (this.isPunct('{')) {
            this.next();
            // Namespace members are added to the same (file) scope, with a container name.
            decls = this.parseDeclList(scope, false, inner);
            if (this.isPunct('}')) { this.next(); }
        }
        const decl: NamespaceDecl = {
            kind: 'NamespaceDecl', name, nameSpan, decls,
            span: { start: kw.start, end: this.prevEnd() },
        };
        if (name) { addSymbol(scope, name, decl, SymbolKind.Namespace); }
        return decl;
    }

    // --- general declaration / function ----------------------------------

    private parseDeclarationOrFunction(scope: Scope, containerName: string | undefined, attrs: Attribute[]): Decl[] {
        const start = this.cur().start;
        const modsAndType = this.tryParseModifiersAndType();
        if (!modsAndType) { this.skipToSemicolon(); return []; }
        const { modifiers, type } = modsAndType;

        if (!this.isIdent()) {
            // e.g. `Type;` (forward) or something unparseable
            this.skipToSemicolon();
            return [];
        }

        const nameTok = this.next();

        // Function?
        if (this.isPunct('(')) {
            return [this.parseFunctionRest(scope, containerName, attrs, type, nameTok, start)];
        }

        // Otherwise variable(s) / resource(s). Re-handle the first declarator + any commas.
        return this.parseVariableRest(scope, containerName, modifiers, type, nameTok, start);
    }

    private parseFunctionRest(scope: Scope, containerName: string | undefined, attrs: Attribute[], returnType: TypeRef, nameTok: Token, start: number): FunctionDecl {
        const params = this.parseParamList();
        let semantic: string | undefined;
        if (this.isPunct(':')) { this.next(); if (this.isIdent()) { semantic = this.next().value; } }

        let isDefinition = false;
        let body: Scope | undefined;
        if (this.isPunct('{')) {
            isDefinition = true;
            body = this.parseBlock(scope, params);
        } else {
            this.skipToSemicolon();
        }

        const decl: FunctionDecl = {
            kind: 'FunctionDecl', name: nameTok.value, nameSpan: { start: nameTok.start, end: nameTok.end },
            returnType, params, semantic, attributes: attrs, isDefinition, body, containerName,
            span: { start, end: this.prevEnd() },
        };
        addSymbol(scope, decl.name, decl, containerName ? SymbolKind.Method : SymbolKind.Function, returnType);
        return decl;
    }

    private parseVariableRest(scope: Scope, containerName: string | undefined, modifiers: string[], type: TypeRef, firstName: Token, start: number): Decl[] {
        const out: Decl[] = [];
        let nameTok: Token | null = firstName;
        do {
            if (!nameTok) {
                if (!this.isIdent()) { break; }
                nameTok = this.next();
            }
            const declType = this.applyArraySuffix(type);
            let semantic: string | undefined;
            let register: string | undefined;
            let packoffset: string | undefined;
            if (this.isPunct(':')) {
                this.next();
                if (this.isIdent('register')) { this.next(); register = this.readParenContents(); }
                else if (this.isIdent('packoffset')) { this.next(); packoffset = this.readParenContents(); }
                else if (this.isIdent()) { semantic = this.next().value; if (this.isPunct('(')) { this.skipBalanced('(', ')'); } }
            }
            // second annotation (e.g. : register(...) : packoffset(...))
            if (this.isPunct(':')) {
                this.next();
                if (this.isIdent('register')) { this.next(); register = this.readParenContents(); }
                else if (this.isIdent('packoffset')) { this.next(); packoffset = this.readParenContents(); }
                else if (this.isIdent()) { this.next(); }
            }
            if (this.isPunct('=')) { this.skipUntilCommaOrSemicolon(); }

            const isResource = KNOWN_RESOURCE_TYPES.has(type.name);
            const span: NodeSpan = { start, end: nameTok.end };
            let decl: Decl;
            if (isResource) {
                decl = { kind: 'ResourceDecl', name: nameTok.value, nameSpan: { start: nameTok.start, end: nameTok.end }, type: declType, register, span };
                addSymbol(scope, nameTok.value, decl, SymbolKind.Field, declType);
            } else {
                decl = { kind: 'VariableDecl', name: nameTok.value, nameSpan: { start: nameTok.start, end: nameTok.end }, type: declType, modifiers, semantic, register, packoffset, containerName, span };
                addSymbol(scope, nameTok.value, decl, SymbolKind.Variable, declType);
            }
            out.push(decl);
            nameTok = null;
        } while (this.matchPunct(','));
        this.skipToSemicolon();
        return out;
    }

    private parseParamList(): ParamDecl[] {
        const params: ParamDecl[] = [];
        if (!this.isPunct('(')) { return params; }
        this.next(); // (
        while (!this.atEnd() && !this.isPunct(')')) {
            // direction + modifiers
            let direction: ParamDecl['direction'] = 'none';
            while (this.isIdent('in') || this.isIdent('out') || this.isIdent('inout') || (this.isIdent() && MODIFIERS.has(this.cur().value))) {
                const v = this.cur().value;
                if (v === 'in' || v === 'out' || v === 'inout') { direction = v as ParamDecl['direction']; }
                this.next();
            }
            const type = this.parseType();
            if (!type || !this.isIdent()) {
                // can't parse this param; skip to , or )
                this.skipParam();
                if (this.matchPunct(',')) { continue; } else { break; }
            }
            const nt = this.next();
            const ptype = this.applyArraySuffix(type);
            let semantic: string | undefined;
            if (this.isPunct(':')) { this.next(); if (this.isIdent()) { semantic = this.next().value; } }
            if (this.isPunct('=')) { this.skipParam(); }
            params.push({
                kind: 'ParamDecl', name: nt.value, nameSpan: { start: nt.start, end: nt.end },
                type: ptype, direction, semantic, span: { start: type.name ? nt.start : nt.start, end: nt.end },
            });
            if (!this.matchPunct(',')) { break; }
        }
        if (this.isPunct(')')) { this.next(); }
        return params;
    }

    // --- function body / scopes -----------------------------------------

    private parseBlock(parent: Scope, params: ParamDecl[]): Scope {
        const open = this.cur(); // {
        this.next();
        const scope = newScope(parent, { start: open.start, end: open.end });
        if (parent) { parent.children.push(scope); }
        // params live in the function body scope
        for (const p of params) {
            addSymbol(scope, p.name, p, SymbolKind.Variable, p.type);
        }
        this.parseStatements(scope);
        if (this.isPunct('}')) { scope.span.end = this.cur().end; this.next(); }
        else { scope.span.end = this.prevEnd(); }
        return scope;
    }

    private parseStatements(scope: Scope): void {
        let atStmtStart = true;
        while (!this.atEnd() && !this.isPunct('}')) {
            const t = this.cur();

            if (t.kind === TokenKind.Punct) {
                if (t.value === '{') {
                    this.parseBlock(scope, []); // auto-links itself as a child scope
                    atStmtStart = true;
                    continue;
                }
                if (t.value === ';') { this.next(); atStmtStart = true; continue; }
                this.next();
                atStmtStart = false;
                continue;
            }

            if (t.kind === TokenKind.Identifier) {
                if (t.value === 'for') {
                    this.next();
                    this.parseForInit(scope);
                    atStmtStart = false;
                    continue;
                }
                if (CONTROL_KEYWORDS.has(t.value)) { this.next(); atStmtStart = false; continue; }
                if (atStmtStart && this.tryParseLocalDecl(scope)) { atStmtStart = true; continue; }
                this.next();
                atStmtStart = false;
                continue;
            }

            // numbers / strings / preprocessor inside a body
            this.next();
            atStmtStart = false;
        }
    }

    private parseForInit(scope: Scope): void {
        if (!this.isPunct('(')) { return; }
        this.next();
        // try to parse a declaration as the init clause
        this.tryParseLocalDecl(scope);
        // skip the rest of the for(...) header
        let depth = 1;
        while (!this.atEnd() && depth > 0) {
            if (this.isPunct('(')) { depth++; }
            else if (this.isPunct(')')) { depth--; if (depth === 0) { this.next(); break; } }
            this.next();
        }
    }

    /** Attempt `[mods] type name [array] [= ...]` at a statement start; rolls back on mismatch. */
    private tryParseLocalDecl(scope: Scope): boolean {
        const save = this.i;
        const modsAndType = this.tryParseModifiersAndType();
        if (!modsAndType || !this.isIdent()) { this.i = save; return false; }
        // Need at least: type ident, and after the declarator a `=`,`;`,`,` or `[`.
        const nameTok = this.peek();
        const after = this.peek(1);
        const looksLikeDecl = after.kind === TokenKind.Punct &&
            (after.value === ';' || after.value === '=' || after.value === ',' || after.value === '[');
        if (!looksLikeDecl) { this.i = save; return false; }

        const { type } = modsAndType;
        let added = false;
        do {
            if (!this.isIdent()) { break; }
            const nt = this.next();
            const declType = this.applyArraySuffix(type);
            const decl: VariableDecl = {
                kind: 'VariableDecl', name: nt.value, nameSpan: { start: nt.start, end: nt.end },
                type: declType, modifiers: modsAndType.modifiers, span: { start: nt.start, end: nt.end },
            };
            addSymbol(scope, nt.value, decl, SymbolKind.Variable, declType);
            added = true;
            if (this.isPunct('=')) { this.skipUntilCommaOrSemicolon(); }
        } while (this.matchPunct(','));
        this.skipToSemicolon();
        return added;
    }

    // --- shared sub-parsers ---------------------------------------------

    private tryParseModifiersAndType(): { modifiers: string[]; type: TypeRef } | null {
        const modifiers: string[] = [];
        while (this.isIdent() && MODIFIERS.has(this.cur().value)) {
            modifiers.push(this.next().value);
        }
        const type = this.parseType();
        if (!type) { return null; }
        return { modifiers, type };
    }

    private parseType(): TypeRef | null {
        if (!this.isIdent()) { return null; }
        let name = this.next().value;
        // qualified name a::b::c
        while (this.isPunct('::') && this.isIdent(undefined, 1)) {
            this.next(); // ::
            name += '::' + this.next().value;
        }
        const ref: TypeRef = { name };
        // template args
        if (this.isPunct('<')) {
            ref.args = this.parseTemplateArgs();
        }
        return ref;
    }

    private parseTemplateArgs(): TypeRef[] {
        const args: TypeRef[] = [];
        this.next(); // <
        let depth = 1;
        while (!this.atEnd() && depth > 0) {
            if (this.isIdent()) {
                const inner = this.parseType();
                if (inner) { args.push(inner); continue; }
            }
            if (this.isPunct('<')) { depth++; this.next(); continue; }
            if (this.isPunct('>')) { depth--; this.next(); if (depth === 0) { break; } continue; }
            if (this.isPunct('>>')) { depth -= 2; this.next(); if (depth <= 0) { break; } continue; }
            // commas, numbers (e.g. matrix<float,4,4>), etc.
            this.next();
        }
        return args;
    }

    private tryParseVariableDecls(containerName: string): VariableDecl[] {
        const start = this.cur().start;
        const modsAndType = this.tryParseModifiersAndType();
        if (!modsAndType || !this.isIdent()) { return []; }
        const { modifiers, type } = modsAndType;
        const out: VariableDecl[] = [];
        do {
            if (!this.isIdent()) { break; }
            const nt = this.next();
            const declType = this.applyArraySuffix(type);
            let semantic: string | undefined;
            let packoffset: string | undefined;
            if (this.isPunct(':')) {
                this.next();
                if (this.isIdent('packoffset')) { this.next(); packoffset = this.readParenContents(); }
                else if (this.isIdent()) { semantic = this.next().value; if (this.isPunct('(')) { this.skipBalanced('(', ')'); } }
            }
            if (this.isPunct('=')) { this.skipUntilCommaOrSemicolon(); }
            out.push({
                kind: 'VariableDecl', name: nt.value, nameSpan: { start: nt.start, end: nt.end },
                type: declType, modifiers, semantic, packoffset, containerName,
                span: { start, end: nt.end },
            });
        } while (this.matchPunct(','));
        this.skipToSemicolon();
        return out;
    }

    private parseAttributes(): Attribute[] {
        const attrs: Attribute[] = [];
        while (this.isPunct('[')) {
            const open = this.cur();
            this.next();
            // [[vk::binding]] style
            const doubleBracket = this.isPunct('[');
            if (doubleBracket) { this.next(); }
            let name = '';
            if (this.isIdent()) { name = this.next().value; }
            let argStr = '';
            if (this.isPunct('(')) { argStr = this.readParenContents() || ''; }
            // consume to closing bracket(s)
            while (!this.atEnd() && !this.isPunct(']')) { this.next(); }
            if (this.isPunct(']')) { this.next(); }
            if (doubleBracket && this.isPunct(']')) { this.next(); }
            attrs.push({ name, args: argStr, span: { start: open.start, end: this.prevEnd() } });
        }
        return attrs;
    }

    private applyArraySuffix(type: TypeRef): TypeRef {
        let dims = 0;
        while (this.isPunct('[')) {
            this.skipBalanced('[', ']');
            dims++;
        }
        if (dims === 0) { return type; }
        return { name: type.name, args: type.args, arrayDims: (type.arrayDims || 0) + dims };
    }

    // --- low-level skips -------------------------------------------------

    private matchPunct(v: string): boolean {
        if (this.isPunct(v)) { this.next(); return true; }
        return false;
    }

    private prevEnd(): number {
        return this.i > 0 ? this.tokens[this.i - 1].end : 0;
    }

    private skipToSemicolon(): void {
        while (!this.atEnd()) {
            if (this.isPunct(';')) { this.next(); return; }
            if (this.isPunct('}')) { return; }
            if (this.isPunct('{')) { this.skipBalanced('{', '}'); continue; }
            this.next();
        }
    }

    private skipUntilCommaOrSemicolon(): void {
        // used to skip an initializer expression; respects nested brackets
        while (!this.atEnd()) {
            if (this.isPunct(',') || this.isPunct(';')) { return; }
            if (this.isPunct('}')) { return; }
            if (this.isPunct('(')) { this.skipBalanced('(', ')'); continue; }
            if (this.isPunct('{')) { this.skipBalanced('{', '}'); continue; }
            if (this.isPunct('[')) { this.skipBalanced('[', ']'); continue; }
            this.next();
        }
    }

    private skipParam(): void {
        let depth = 0;
        while (!this.atEnd()) {
            if (this.isPunct('(') || this.isPunct('[') || this.isPunct('{')) { depth++; this.next(); continue; }
            if (this.isPunct(')')) { if (depth === 0) { return; } depth--; this.next(); continue; }
            if (this.isPunct(']') || this.isPunct('}')) { depth--; this.next(); continue; }
            if (depth === 0 && this.isPunct(',')) { return; }
            this.next();
        }
    }

    private skipBalanced(open: string, close: string): void {
        if (!this.isPunct(open)) { return; }
        let depth = 0;
        while (!this.atEnd()) {
            if (this.isPunct(open)) { depth++; this.next(); continue; }
            if (this.isPunct(close)) { depth--; this.next(); if (depth === 0) { return; } continue; }
            this.next();
        }
    }

    /** Reads `(...)` and returns the inner text sliced from the source. */
    private readParenContents(): string | undefined {
        if (!this.isPunct('(')) { return undefined; }
        const open = this.cur();
        this.skipBalanced('(', ')');
        const closeEnd = this.prevEnd(); // offset just past the closing ')'
        return this.lexer.source.slice(open.end, Math.max(open.end, closeEnd - 1)).trim();
    }

    private readRegisterLike(): string | undefined {
        if (this.isIdent('register')) { this.next(); return this.readParenContents(); }
        if (this.isIdent()) { const v = this.next().value; if (this.isPunct('(')) { this.skipBalanced('(', ')'); } return v; }
        return undefined;
    }
}

// --- scope helpers -----------------------------------------------------

function newScope(parent: Scope | null, span: NodeSpan): Scope {
    return { parent, span, symbols: new Map(), children: [] };
}

function addSymbol(scope: Scope, name: string, decl: SymbolEntry['decl'], kind: SymbolKind, type?: TypeRef): void {
    if (!name) { return; }
    const entry: SymbolEntry = { name, decl, kind, type };
    const existing = scope.symbols.get(name);
    if (existing) { existing.push(entry); }
    else { scope.symbols.set(name, [entry]); }
}
