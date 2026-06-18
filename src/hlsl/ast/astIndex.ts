'use strict';

import {
    SymbolInformation, SymbolKind, Uri, TextDocument, Location, Range, Position,
    Disposable, workspace, window, ProgressLocation, Hover, MarkdownString,
    CompletionItem, SignatureHelp, SignatureInformation, ParameterInformation,
    MarkedString,
} from 'vscode';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execAsync = promisify(exec);
import { ISymbolBackend } from '../symbolBackend';
import { getHlslExtensions, rgPath } from '../../common';
import { parse } from './parser';
import { offsetToPosition } from './lexer';
import { parseUniformBuffers } from './unrealParams';
import { symbolsFromFile } from './symbolBuilder';
import { scopeAtOffset, resolve } from './scope';
import { parseAccessChain, resolveChainType, membersOfType, typeRefToString, TypeProvider } from './memberResolver';
import { SymbolStore, SymbolRow } from './symbolStore';
import {
    SourceFile, Decl, StructDecl, FunctionDecl, TypeRef, NodeSpan,
    NamespaceDecl, VariableDecl, ResourceDecl, CBufferDecl, MacroDecl, TypedefDecl,
} from './nodes';

/** Cap on rows materialised for "all symbols" / workspace-symbol queries. */
const QUERY_LIMIT = 5000;

// Build-artifact / dependency directories excluded from indexing by default.
// Unreal projects in particular emit thousands of fully-preprocessed shader
// dumps under Saved/ (each with thousands of declarations) — crawling them
// exhausts the extension host's heap. These are not source the user edits.
// User-overridable via the `hlsl.ast.excludeDirs` setting.
const DEFAULT_EXCLUDED_DIRS = ['node_modules', '.git', 'Saved', 'Intermediate', 'Binaries', 'DerivedDataCache'];

function getExcludedDirs(): string[] {
    const v = workspace.getConfiguration('hlsl').get<string[]>('ast.excludeDirs', DEFAULT_EXCLUDED_DIRS);
    return Array.isArray(v) && v.length > 0 ? v : DEFAULT_EXCLUDED_DIRS;
}

/** A findFiles exclude glob from a directory-name list, e.g. `**\/{Saved,Binaries}/**`. */
function excludeGlobFrom(dirs: string[]): string {
    return `**/{${dirs.join(',')}}/**`;
}

/** A path test matching any excluded directory name as a full path segment. */
function excludeReFrom(dirs: string[]): RegExp {
    const escaped = dirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`[\\\\/](${escaped.join('|')})[\\\\/]`, 'i');
}

/**
 * AST-backed symbol engine. Parses every HLSL file in the workspace into an
 * AST, indexes the derived symbols + struct/typedef tables for fast lookup,
 * and exposes scope-aware definitions, member completion, typed hover, and
 * signature help. Implements ISymbolBackend so it is interchangeable with the
 * regex-based SymbolCache.
 */
export class AstIndex implements ISymbolBackend, TypeProvider {
    // Full ASTs (incl. scope trees + lineStarts) are heavy, so only a bounded
    // set is kept resident — enough for the documents the user is actively
    // navigating. Every other file contributes only the lightweight derived
    // data below. This keeps memory flat regardless of workspace size.
    private astCache = new LruCache<string, SourceFile>(64);
    private docVersions = new Map<string, number>();
    // Symbols live in SQLite (off-heap, queried on demand). Only the small type
    // model needed for AST features (member resolution, hover, signatures) is
    // kept resident in memory.
    private store = new SymbolStore();
    private ready: Promise<void>;
    private structIndex = new Map<string, StructDecl>();
    private typedefIndex = new Map<string, TypeRef>();
    private functionIndex = new Map<string, FunctionDecl>();
    private fileNames = new Map<string, { structs: string[]; typedefs: string[]; functions: string[] }>();
    private fileModTimes = new Map<string, number>();

    private subscriptions: Disposable[] = [];
    private refreshInterval: NodeJS.Timeout;
    private refreshPromise: Promise<void> | null = null;
    private refreshTimeSlice = 1000;
    private workspaceRefreshInterval = 30000;
    private cachePath: string;
    private wasmDir: string;
    private cppScanned = false;

    constructor(cachePath: string = '', wasmDir: string = __dirname) {
        this.cachePath = cachePath;
        this.wasmDir = wasmDir;
        this.ready = this.store.init(this.wasmDir, this.cachePath || undefined)
            .catch(e => { console.error('SymbolStore init failed:', e); });
        this.setupListeners();
        this.refreshInterval = setInterval(() => {
            this.refreshWithProgress().catch(e => console.error('AST refresh error:', e));
        }, this.workspaceRefreshInterval);
        this.refreshWithProgress().catch(e => console.error('AST initial refresh error:', e));
    }

    // === ISymbolBackend: core ==========================================

    async getDocumentSymbols(document: TextDocument): Promise<SymbolInformation[]> {
        await this.ready;
        this.ensureDocumentParsed(document);
        return this.store.byUri(document.uri.toString()).map(rowToSymbol);
    }

    async findSymbol(name: string, document?: TextDocument): Promise<SymbolInformation | null> {
        await this.ready;
        if (document) { this.ensureDocumentParsed(document); }
        const rows = this.store.byName(name);
        if (rows.length === 0) { return null; }
        if (document) {
            const uri = document.uri.toString();
            const local = rows.find(r => r.uri === uri);
            if (local) { return rowToSymbol(local); }
        }
        return rowToSymbol(rows[0]);
    }

    async findSymbols(name: string): Promise<SymbolInformation[]> {
        await this.ready;
        const rows = name ? this.store.byName(name) : this.store.search('', QUERY_LIMIT);
        return rows.map(rowToSymbol);
    }

    async provideWorkspaceSymbols(query: string): Promise<SymbolInformation[]> {
        await this.ready;
        return this.store.search(query, QUERY_LIMIT).map(rowToSymbol);
    }

    // === ISymbolBackend: AST capabilities ===============================

    async resolveDefinition(document: TextDocument, position: Position): Promise<Location[] | null> {
        await this.ready;
        const range = document.getWordRangeAtPosition(position);
        if (!range) { return null; }
        const name = document.getText(range);

        const file = this.ensureDocumentParsed(document);
        const offset = document.offsetAt(position);
        const scope = scopeAtOffset(file, offset);
        const entry = resolve(scope, name);
        if (entry) {
            const span = (entry.decl as any).nameSpan as NodeSpan | undefined;
            if (span) {
                return [new Location(document.uri, this.spanToRange(file, span))];
            }
        }

        // Fall back to cross-file name matches from the index.
        const matches = this.store.byName(name);
        if (matches.length > 0) {
            return matches.map(r => rowToSymbol(r).location);
        }
        return null;
    }

    async completeMembers(document: TextDocument, position: Position): Promise<CompletionItem[] | null> {
        await this.ready;
        const lineText = document.lineAt(position.line).text;
        // Find the `.` immediately preceding the (possibly partial) member word.
        const wordRange = document.getWordRangeAtPosition(position);
        const dotCol = (wordRange ? wordRange.start.character : position.character) - 1;
        if (dotCol < 0 || lineText[dotCol] !== '.') { return null; }

        const chain = parseAccessChain(lineText.slice(0, dotCol));
        if (!chain) { return null; }

        const file = this.ensureDocumentParsed(document);
        const offset = document.offsetAt(position);
        const scope = scopeAtOffset(file, offset);
        const type = resolveChainType(chain, scope, file, this);
        if (!type) { return null; }

        const swizzle = workspace.getConfiguration('hlsl').get<boolean>('ast.swizzleCompletion', true);
        const items = membersOfType(type, file, this, swizzle);
        return items.length > 0 ? items : null;
    }

    async describeSymbol(document: TextDocument, position: Position): Promise<Hover | null> {
        await this.ready;
        const range = document.getWordRangeAtPosition(position);
        if (!range) { return null; }
        const name = document.getText(range);

        const file = this.ensureDocumentParsed(document);
        const offset = document.offsetAt(position);
        const scope = scopeAtOffset(file, offset);
        const entry = resolve(scope, name);
        const decl = entry ? entry.decl : this.findDeclByName(name);
        if (!decl) { return null; }

        const signature = describeDecl(decl as Decl);
        if (!signature) { return null; }

        const contents: MarkedString[] = [new MarkdownString(signature.header)];
        if (signature.code) {
            contents.push({ language: 'hlsl', value: signature.code });
        }
        return new Hover(contents, range);
    }

    async getSignature(document: TextDocument, position: Position): Promise<SignatureHelp | null> {
        await this.ready;
        // Walk backwards to the enclosing call's function name + active parameter.
        const info = findEnclosingCall(document, position);
        if (!info) { return null; }
        const fn = this.findFunction(info.name);
        if (!fn) { return null; }

        const paramLabels = fn.params.map(p => {
            const dir = p.direction !== 'none' ? p.direction + ' ' : '';
            return `${dir}${typeRefToString(p.type)} ${p.name}`;
        });
        const label = `${typeRefToString(fn.returnType)} ${fn.name}(${paramLabels.join(', ')})`;
        const sig = new SignatureInformation(label);
        sig.parameters = paramLabels.map(l => new ParameterInformation(l));

        const help = new SignatureHelp();
        help.signatures = [sig];
        help.activeSignature = 0;
        help.activeParameter = Math.min(info.activeParam, Math.max(0, paramLabels.length - 1));
        return help;
    }

    // === TypeProvider ===================================================

    findStruct(name: string): StructDecl | undefined { return this.structIndex.get(name); }
    resolveTypedef(name: string): TypeRef | undefined { return this.typedefIndex.get(name); }

    // === refresh / scan =================================================

    async refreshWithProgress(force: boolean = false): Promise<void> {
        if (this.refreshPromise) { await this.refreshPromise; return; }
        const scanCpp = force || !this.cppScanned;
        this.refreshPromise = (async () => {
            await window.withProgress({
                location: ProgressLocation.Window,
                title: 'Parsing HLSL symbols',
                cancellable: true,
            }, async (progress, cancel) => {
                progress.report({ message: 'Discovering files...' });
                const uris = await this.discoverFiles();
                let start = Date.now();
                let processed = 0;
                for (const uri of uris) {
                    if (cancel.isCancellationRequested) { break; }
                    await this.parseFromDisk(uri);
                    processed++;
                    if (Date.now() - start >= this.refreshTimeSlice) {
                        progress.report({ message: `${processed}/${uris.length} files` });
                        await new Promise(r => setTimeout(r, 0));
                        start = Date.now();
                    }
                }

                // Index Unreal C++ uniform-buffer / shader-parameter structs so
                // their members resolve to the C++ declaration. This involves a
                // ripgrep sweep + parsing, so only do it on the first refresh and
                // on explicit (forced) refreshes — not every periodic tick.
                if (scanCpp && workspace.getConfiguration('hlsl').get<boolean>('ast.unrealUniformBuffers', true)) {
                    progress.report({ message: 'Scanning C++ uniform buffers...' });
                    const cppUris = await this.discoverCppFiles();
                    for (const uri of cppUris) {
                        if (cancel.isCancellationRequested) { break; }
                        this.scanCppFile(uri);
                        if (Date.now() - start >= this.refreshTimeSlice) {
                            await new Promise(r => setTimeout(r, 0));
                            start = Date.now();
                        }
                    }
                    this.cppScanned = true;
                }

                this.save();
                progress.report({ message: 'Done' });
            });
        })();
        try { await this.refreshPromise; } finally { this.refreshPromise = null; }
    }

    private async discoverFiles(): Promise<Uri[]> {
        const exts = getHlslExtensions().map(e => e.replace(/^\./, ''));
        const include = `**/*.{${exts.join(',')}}`;
        return workspace.findFiles(include, excludeGlobFrom(getExcludedDirs()));
    }

    /**
     * Candidate C++ files that declare an Unreal shader-parameter / uniform-buffer
     * struct. Uses ripgrep to pre-filter (an Engine tree has tens of thousands of
     * C++ files; only a few hundred contain these macros), so we only read & parse
     * the relevant ones.
     */
    private async discoverCppFiles(): Promise<Uri[]> {
        const ws = workspace.workspaceFolders?.[0];
        if (!rgPath || !ws) { return []; }
        const root = ws.uri.fsPath;
        const excludes = getExcludedDirs().map(d => `-g "!**/${d}/**"`).join(' ');
        const cmd = `"${rgPath}" -l --pcre2 --hidden ${excludes} -g "*.h" -g "*.cpp" -g "*.inl" ` +
            `-e "BEGIN_[A-Z0-9_]*(SHADER_PARAMETER|UNIFORM_BUFFER)_STRUCT" .`;
        try {
            // Async exec: ripgrep can take seconds on a large tree, so it must NOT
            // block the extension host (execSync would freeze every provider).
            const { stdout } = await execAsync(cmd, { cwd: root, maxBuffer: 1024 * 1024 * 200 });
            return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(rel => Uri.file(join(root, rel)));
        } catch {
            return [];
        }
    }

    /** Parse one C++ file's uniform-buffer structs into store symbols + the type model. */
    private scanCppFile(uri: Uri): void {
        const key = uri.toString();
        try {
            const stat = fs.statSync(uri.fsPath);
            const prev = this.fileModTimes.get(key);
            if (prev !== undefined && prev === stat.mtimeMs && this.store.hasFile(key)) { return; }

            const text = fs.readFileSync(uri.fsPath, 'utf8');
            const scan = parseUniformBuffers(text);
            this.fileModTimes.set(key, stat.mtimeMs);

            const memberCount = scan.looseMembers.length + scan.structs.reduce((n, s) => n + s.members.length, 0);
            if (scan.structs.length === 0 && memberCount === 0) { this.unindexFile(key); return; }

            const lineStarts = lineStartsOf(text);
            const toPos = (off: number) => offsetToPosition(lineStarts, off);
            const rows: SymbolRow[] = [];
            this.unindexTypes(key);
            const names = { structs: [] as string[], typedefs: [] as string[], functions: [] as string[] };

            const fieldDecl = (mem: { name: string; type: string; nameOffset: number }) => ({
                kind: 'FieldDecl', name: mem.name,
                nameSpan: { start: mem.nameOffset, end: mem.nameOffset + mem.name.length },
                type: { name: mem.type || 'float' },
                span: { start: mem.nameOffset, end: mem.nameOffset + mem.name.length },
            });

            for (const s of scan.structs) {
                const sp = toPos(s.nameOffset);
                rows.push({ name: s.name, kind: SymbolKind.Struct, container: '', uri: key, sl: sp.line, sc: sp.character, el: sp.line, ec: sp.character + s.name.length });

                const fields: any[] = [];
                for (const mem of s.members) {
                    const mp = toPos(mem.nameOffset);
                    rows.push({ name: mem.name, kind: SymbolKind.Field, container: s.name, uri: key, sl: mp.line, sc: mp.character, el: mp.line, ec: mp.character + mem.name.length });
                    fields.push(fieldDecl(mem));
                }
                // Register the struct so HLSL member completion works on a variable typed with it.
                const decl: StructDecl = {
                    kind: 'StructDecl', name: s.name, isClass: false, fields,
                    nameSpan: { start: s.nameOffset, end: s.nameOffset + s.name.length },
                    span: { start: s.nameOffset, end: s.nameOffset + s.name.length },
                };
                this.structIndex.set(s.name, decl);
                names.structs.push(s.name);
            }

            // Members declared outside a struct block (e.g. UE's View member table)
            // are indexed by name so go-to-definition / find-references still resolve.
            for (const mem of scan.looseMembers) {
                const mp = toPos(mem.nameOffset);
                rows.push({ name: mem.name, kind: SymbolKind.Field, container: '', uri: key, sl: mp.line, sc: mp.character, el: mp.line, ec: mp.character + mem.name.length });
            }

            this.store.replaceFile(key, rows);
            this.fileNames.set(key, names);
        } catch {
            // unreadable file: skip
        }
    }

    private async parseFromDisk(uri: Uri): Promise<void> {
        const key = uri.toString();
        // Prefer a live (possibly unsaved) document.
        const open = workspace.textDocuments.find(d => d.uri.toString() === key);
        if (open) {
            this.ensureDocumentParsed(open);
            return;
        }
        try {
            const stat = fs.statSync(uri.fsPath);
            const prev = this.fileModTimes.get(key);
            if (prev !== undefined && prev === stat.mtimeMs && this.store.hasFile(key)) {
                return; // unchanged
            }
            const text = fs.readFileSync(uri.fsPath, 'utf8');
            const file = parse(text, key);
            // Workspace scan: index the lightweight data only; let the full AST
            // (scope trees, lineStarts) be garbage-collected immediately.
            this.indexFile(key, file);
            this.fileModTimes.set(key, stat.mtimeMs);
        } catch {
            // unreadable file: skip
        }
    }

    private ensureDocumentParsed(document: TextDocument): SourceFile {
        const key = document.uri.toString();
        const cached = this.astCache.get(key);
        if (cached && this.docVersions.get(key) === document.version) {
            return cached;
        }
        const file = parse(document.getText(), key);
        this.indexFile(key, file);
        // Keep the full AST resident only for documents the user is navigating.
        this.astCache.set(key, file);
        this.docVersions.set(key, document.version);
        return file;
    }

    // === indexing =======================================================

    /** Persist a file's symbols to the store + refresh the in-memory type model. Does NOT retain the AST. */
    private indexFile(key: string, file: SourceFile): void {
        this.unindexTypes(key);

        const rows: SymbolRow[] = symbolsFromFile(file).map(s => {
            const r = s.location.range;
            return {
                name: s.name, kind: s.kind, container: s.containerName || '', uri: key,
                sl: r.start.line, sc: r.start.character, el: r.end.line, ec: r.end.character,
            };
        });
        this.store.replaceFile(key, rows);

        const names = { structs: [] as string[], typedefs: [] as string[], functions: [] as string[] };
        this.collectTypes(file.decls, names);
        this.fileNames.set(key, names);
    }

    private collectTypes(decls: Decl[], names: { structs: string[]; typedefs: string[]; functions: string[] }): void {
        for (const d of decls) {
            if (d.kind === 'StructDecl' && d.name) {
                this.structIndex.set(d.name, d);
                names.structs.push(d.name);
            } else if (d.kind === 'TypedefDecl' && d.name) {
                this.typedefIndex.set(d.name, d.underlying);
                names.typedefs.push(d.name);
            } else if (d.kind === 'FunctionDecl' && d.name) {
                // Store a body-less copy so the (heavy) function-body scope tree
                // can be collected; signature help only needs params + return type.
                this.functionIndex.set(d.name, { ...(d as FunctionDecl), body: undefined });
                names.functions.push(d.name);
            } else if (d.kind === 'NamespaceDecl') {
                this.collectTypes((d as NamespaceDecl).decls, names);
            }
        }
    }

    /** Drop the in-memory type entries a file contributed (symbols handled by the store). */
    private unindexTypes(key: string): void {
        const names = this.fileNames.get(key);
        if (names) {
            // If another file declares the same name it is re-added on its next (re)parse.
            for (const n of names.structs) { this.structIndex.delete(n); }
            for (const n of names.typedefs) { this.typedefIndex.delete(n); }
            for (const n of names.functions) { this.functionIndex.delete(n); }
            this.fileNames.delete(key);
        }
    }

    /** Full removal of a file (e.g. on delete): symbols, type model, and cached AST. */
    private unindexFile(key: string): void {
        this.store.removeFile(key);
        this.unindexTypes(key);
        this.astCache.delete(key);
    }

    private findDeclByName(name: string): Decl | undefined {
        return this.structIndex.get(name) || this.functionIndex.get(name);
    }

    private findFunction(name: string): FunctionDecl | undefined {
        return this.functionIndex.get(name);
    }

    private spanToRange(file: SourceFile, span: NodeSpan): Range {
        return new Range(
            offsetToPosition(file.lineStarts, span.start),
            offsetToPosition(file.lineStarts, span.end),
        );
    }

    // === listeners / lifecycle =========================================

    private setupListeners(): void {
        this.subscriptions.push(workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'hlsl') {
                // Re-parse lazily on next access; just drop the cached version.
                this.docVersions.delete(e.document.uri.toString());
            }
        }));
        this.subscriptions.push(workspace.onDidCloseTextDocument(doc => {
            this.docVersions.delete(doc.uri.toString());
        }));

        const exts = getHlslExtensions().map(e => e.replace(/^\./, ''));
        const watcher = workspace.createFileSystemWatcher(`**/*.{${exts.join(',')}}`);
        const reparse = (uri: Uri) => {
            if (excludeReFrom(getExcludedDirs()).test(uri.fsPath)) { return; } // skip excluded dirs
            this.parseFromDisk(uri).catch(() => {});
        };
        watcher.onDidCreate(reparse);
        watcher.onDidChange(reparse);
        watcher.onDidDelete(uri => { this.unindexFile(uri.toString()); this.fileModTimes.delete(uri.toString()); });
        this.subscriptions.push(watcher);
    }

    dispose(): void {
        if (this.refreshInterval) { clearInterval(this.refreshInterval); }
        this.subscriptions.forEach(s => s.dispose());
        this.save();
        this.store.dispose();
    }

    // === persistence (symbols live in the on-disk SQLite db) ============

    private save(): void {
        if (this.cachePath) { this.store.save(this.cachePath); }
    }
}

// --- helpers -----------------------------------------------------------

/** Offsets of the start of each line, for offset -> Position mapping (C++ files). */
function lineStartsOf(src: string): number[] {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src.charCodeAt(i) === 0x0a) { starts.push(i + 1); }
    }
    return starts;
}

/** Build a vscode SymbolInformation from a stored row. */
function rowToSymbol(r: SymbolRow): SymbolInformation {
    return new SymbolInformation(
        r.name, r.kind as SymbolKind, r.container,
        new Location(Uri.parse(r.uri), new Range(
            new Position(r.sl, r.sc), new Position(r.el, r.ec),
        )),
    );
}

/** Minimal insertion-order LRU: evicts the least-recently-used entry past `max`. */
class LruCache<K, V> {
    private map = new Map<K, V>();
    constructor(private max: number) {}
    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v !== undefined) { this.map.delete(key); this.map.set(key, v); } // mark recent
        return v;
    }
    set(key: K, value: V): void {
        if (this.map.has(key)) { this.map.delete(key); }
        this.map.set(key, value);
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value as K;
            this.map.delete(oldest);
        }
    }
    delete(key: K): void { this.map.delete(key); }
}

/** Build a hover header line + optional code block for a declaration. */
function describeDecl(decl: Decl): { header: string; code?: string } | null {
    switch (decl.kind) {
        case 'FunctionDecl': {
            const f = decl as FunctionDecl;
            const params = f.params.map(p => {
                const dir = p.direction !== 'none' ? p.direction + ' ' : '';
                return `${dir}${typeRefToString(p.type)} ${p.name}`;
            }).join(', ');
            const sem = f.semantic ? ` : ${f.semantic}` : '';
            return {
                header: '(*function*) ',
                code: `${typeRefToString(f.returnType)} ${f.name}(${params})${sem}`,
            };
        }
        case 'StructDecl': {
            const s = decl as StructDecl;
            const body = s.fields.map(fld => `    ${typeRefToString(fld.type)} ${fld.name}${fld.semantic ? ' : ' + fld.semantic : ''};`).join('\n');
            return { header: `(*${s.isClass ? 'class' : 'struct'}*) `, code: `${s.isClass ? 'class' : 'struct'} ${s.name} {\n${body}\n}` };
        }
        case 'CBufferDecl': {
            const c = decl as CBufferDecl;
            const body = c.fields.map(fld => `    ${typeRefToString(fld.type)} ${fld.name};`).join('\n');
            return { header: '(*cbuffer*) ', code: `${c.bufferKind} ${c.name} {\n${body}\n}` };
        }
        case 'VariableDecl': {
            const v = decl as VariableDecl;
            const mods = v.modifiers.length ? v.modifiers.join(' ') + ' ' : '';
            return { header: '(*variable*) ', code: `${mods}${typeRefToString(v.type)} ${v.name}${v.semantic ? ' : ' + v.semantic : ''}` };
        }
        case 'ResourceDecl': {
            const r = decl as ResourceDecl;
            return { header: '(*resource*) ', code: `${typeRefToString(r.type)} ${r.name}${r.register ? ' : register(' + r.register + ')' : ''}` };
        }
        case 'TypedefDecl': {
            const t = decl as TypedefDecl;
            return { header: '(*typedef*) ', code: `typedef ${typeRefToString(t.underlying)} ${t.name}` };
        }
        case 'MacroDecl': {
            const m = decl as MacroDecl;
            const args = m.params ? `(${m.params.join(', ')})` : '';
            return { header: '(*macro*) ', code: `#define ${m.name}${args} ${m.body}`.trim() };
        }
        case 'NamespaceDecl': {
            return { header: `(*namespace*) **${(decl as NamespaceDecl).name}**` };
        }
    }
    return null;
}

/** Backward scan to find the call ident enclosing the cursor and the active param index. */
function findEnclosingCall(document: TextDocument, position: Position): { name: string; activeParam: number } | null {
    const text = document.getText(new Range(new Position(0, 0), position));
    let depth = 0;
    let activeParam = 0;
    let i = text.length - 1;
    for (; i >= 0; i--) {
        const ch = text[i];
        if (ch === ')') { depth++; }
        else if (ch === '(') {
            if (depth === 0) { break; }
            depth--;
        } else if (ch === ',' && depth === 0) { activeParam++; }
        else if ((ch === ';' || ch === '{' || ch === '}') && depth === 0) { return null; }
    }
    if (i < 0) { return null; }
    // read identifier just before the '('
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) { j--; }
    let end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_]/.test(text[j])) { j--; }
    const name = text.slice(j + 1, end);
    if (!name) { return null; }
    return { name, activeParam };
}
