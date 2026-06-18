'use strict'

import { DefinitionProvider, ImplementationProvider, TypeDefinitionProvider, SymbolInformation, TextDocument, Position, Location, CancellationToken, Definition, workspace, commands } from 'vscode';
import { SymbolCache } from './symbolCache';
import { ISymbolBackend } from './symbolBackend';


export default class HLSLDefinitionProvider implements DefinitionProvider, ImplementationProvider, TypeDefinitionProvider {
    private symbolCache: ISymbolBackend;

    constructor(symbolCache?: ISymbolBackend) {
        this.symbolCache = symbolCache || new SymbolCache();
    }

    private async getDefinitionLocations(document: TextDocument, position: Position): Promise<Location[]> {
        const enable = workspace.getConfiguration('hlsl').get<boolean>('suggest.basic', true);
        if (!enable) { return []; }

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return []; }

        const name = document.getText(wordRange);

        // #include "path"
        const line = document.lineAt(position);
        const inc = RegExp('^[\t ]*\#include \"([a-zA-Z/\\\.0-9_]+)\"').exec(line.text);
        if (inc) {
            const files = await workspace.findFiles(inc[1], null, 1);
            return (files && files.length > 0) ? [new Location(files[0], new Position(0, 0))] : [];
        }

        try {
            // AST backend: try scope-aware resolution first.
            if (this.symbolCache.resolveDefinition) {
                const astResult = await this.symbolCache.resolveDefinition(document, position);
                if (astResult && astResult.length > 0) { return astResult; }
            }

            const result: Location[] = [];
            const docSymbols = await this.symbolCache.getDocumentSymbols(document);
            for (const symbol of docSymbols) {
                if (symbol.name === name) { result.push(symbol.location); }
            }
            if (result.length === 0) {
                const wsSymbols = await this.symbolCache.findSymbols(name);
                for (const symbol of wsSymbols) {
                    if (symbol.name === name) { result.push(symbol.location); }
                }
            }
            return result;
        } catch {
            return [];
        }
    }

    public provideDefinition(document: TextDocument, position: Position, token: CancellationToken | boolean): Thenable<Definition> {
        return this.getDefinitionLocations(document, position);
    }

    public provideImplementation(document: TextDocument, position: Position, token: CancellationToken): Thenable<Definition> {
        return this.getDefinitionLocations(document, position);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, token: CancellationToken): Thenable<Definition> {
        return this.getDefinitionLocations(document, position);
    }
}