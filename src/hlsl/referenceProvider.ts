'use strict';

import { ReferenceProvider, CancellationToken, TextDocument, Position, Location, SymbolInformation, commands, workspace } from 'vscode';
import { SymbolCache } from './symbolCache';
import { ISymbolBackend } from './symbolBackend';

export default class HLSLReferenceProvider implements ReferenceProvider {
    private symbolCache: ISymbolBackend;

    constructor(symbolCache?: ISymbolBackend) {
        this.symbolCache = symbolCache || new SymbolCache();
    }

    public async provideReferences(document: TextDocument, position: Position, options: { includeDeclaration: boolean }, token: CancellationToken): Promise<Location[]> {
        const enable = workspace.getConfiguration('hlsl').get<boolean>('suggest.basic', true);
        if (!enable) {
            return [];
        }

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return [];
        }

        const name = document.getText(wordRange);
        if (!name) {
            return [];
        }

        try {
            const results: Location[] = [];
            const text = document.getText();

            // Escape regex metacharacters; \b only applies around word chars.
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'gm');
            let match: RegExpExecArray | null = null;
            let i = 0;
            while ((match = regex.exec(text))) {
                const refRange = document.getWordRangeAtPosition(document.positionAt(match.index));
                if (refRange) { results.push(new Location(document.uri, refRange)); }
                // Honor cancellation so a huge document never blocks indefinitely.
                if ((++i & 0x3ff) === 0 && token.isCancellationRequested) { return results; }
            }

            if (token.isCancellationRequested) { return results; }

            const symbols = await this.symbolCache.findSymbols(name);
            symbols
                .filter(s => s.name === name && s.location.uri.toString() !== document.uri.toString())
                .forEach(symbol => results.push(symbol.location));
            return results;
        } catch {
            return [];
        }
    }
}
