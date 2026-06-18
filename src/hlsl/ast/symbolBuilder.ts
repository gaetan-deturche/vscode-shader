'use strict';

import { SymbolInformation, SymbolKind, Location, Range, Uri } from 'vscode';
import { offsetToPosition } from './lexer';
import {
    SourceFile, Decl, NodeSpan, StructDecl, CBufferDecl, FunctionDecl,
    VariableDecl, ResourceDecl, MacroDecl, TypedefDecl, NamespaceDecl,
} from './nodes';

/** Flatten a parsed file into VS Code SymbolInformation entries (incl. nested members). */
export function symbolsFromFile(file: SourceFile): SymbolInformation[] {
    const uri = Uri.parse(file.uri);
    const out: SymbolInformation[] = [];
    const toRange = (span: NodeSpan) => new Range(
        offsetToPosition(file.lineStarts, span.start),
        offsetToPosition(file.lineStarts, span.end),
    );

    const emit = (name: string, kind: SymbolKind, span: NodeSpan, container: string) => {
        if (!name) { return; }
        out.push(new SymbolInformation(name, kind, container, new Location(uri, toRange(span))));
    };

    const visit = (decls: Decl[], container: string) => {
        for (const d of decls) {
            switch (d.kind) {
                case 'StructDecl': {
                    const s = d as StructDecl;
                    emit(s.name, s.isClass ? SymbolKind.Class : SymbolKind.Struct, s.nameSpan, s.containerName || container);
                    for (const f of s.fields) {
                        emit(f.name, SymbolKind.Field, f.nameSpan, s.name);
                    }
                    break;
                }
                case 'CBufferDecl': {
                    const c = d as CBufferDecl;
                    emit(c.name, SymbolKind.Struct, c.nameSpan, container);
                    for (const f of c.fields) {
                        emit(f.name, SymbolKind.Variable, f.nameSpan, c.name);
                    }
                    break;
                }
                case 'FunctionDecl': {
                    const f = d as FunctionDecl;
                    const cn = f.containerName || container;
                    emit(f.name, cn ? SymbolKind.Method : SymbolKind.Function, f.nameSpan, cn);
                    break;
                }
                case 'VariableDecl': {
                    const v = d as VariableDecl;
                    emit(v.name, SymbolKind.Variable, v.nameSpan, v.containerName || container);
                    break;
                }
                case 'ResourceDecl': {
                    const r = d as ResourceDecl;
                    emit(r.name, SymbolKind.Field, r.nameSpan, container);
                    break;
                }
                case 'MacroDecl': {
                    const m = d as MacroDecl;
                    emit(m.name, m.params ? SymbolKind.Function : SymbolKind.Constant, m.nameSpan, container);
                    break;
                }
                case 'TypedefDecl': {
                    const t = d as TypedefDecl;
                    emit(t.name, SymbolKind.TypeParameter, t.nameSpan, container);
                    break;
                }
                case 'NamespaceDecl': {
                    const n = d as NamespaceDecl;
                    emit(n.name, SymbolKind.Namespace, n.nameSpan, container);
                    const inner = container ? `${container}::${n.name}` : n.name;
                    visit(n.decls, inner);
                    break;
                }
                // IncludeDecl: not a symbol
            }
        }
    };

    visit(file.decls, '');
    return out;
}
