'use strict';

import { SymbolInformation, Uri, TextDocument, commands, Disposable, workspace, Location, Range, Position, window, ProgressLocation } from 'vscode';
import { ISymbolBackend } from './symbolBackend';
import * as fs from 'fs';
import * as Path from 'path';

interface CacheData {
    workspaceSymbols: SerializedSymbol[];
    fileModTimes: [string, number][];
    lastWorkspaceRefresh: number;
}

interface SerializedSymbol {
    name: string;
    kind: number;
    location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
    containerName?: string;
}

export class SymbolCache implements ISymbolBackend {
    private documentSymbols: Map<string, SymbolInformation[]> = new Map();
    private workspaceSymbols: SymbolInformation[] = [];
    private refreshInterval: NodeJS.Timeout;
    private subscriptions: Disposable[] = [];
    private lastWorkspaceRefresh: number = 0;
    private workspaceRefreshInterval: number = 30000;
    private workspaceRefreshPromise: Promise<void> | null = null;
    private fileModTimes: Map<string, number> = new Map();
    private cachePath: string = '';
    private refreshTimeSlice: number = 1000;
    private processedFileTimestamps: Map<string, number> = new Map();

    constructor(cachePath: string = '') {
        console.log('SymbolCache constructor called with path:', cachePath);
        this.cachePath = cachePath;
        this.load();
        this.setupDocumentChangeListener();
        
        this.startPeriodicRefresh();
        this.refreshWithProgress();
    }

    private load(): void {
        if (!this.cachePath) return;
        try {
            if (fs.existsSync(this.cachePath)) {
                const data: CacheData = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
                this.workspaceSymbols = (data.workspaceSymbols || []).map(s => new SymbolInformation(
                    s.name,
                    s.kind as any,
                    s.containerName || '',
                    new Location(Uri.parse(s.location.uri), new Range(
                        new Position(s.location.range.start.line, s.location.range.start.character),
                        new Position(s.location.range.end.line, s.location.range.end.character)
                    ))
                ));
                this.fileModTimes = new Map(data.fileModTimes || []);
                this.lastWorkspaceRefresh = data.lastWorkspaceRefresh || 0;
            }
        } catch {
            // ignore load errors
        }
    }

    save(): void {
        if (!this.cachePath) return;
        try {
            const data: CacheData = {
                workspaceSymbols: this.workspaceSymbols.map(s => ({
                    name: s.name,
                    kind: s.kind,
                    location: {
                        uri: s.location.uri.toString(),
                        range: {
                            start: { line: s.location.range.start.line, character: s.location.range.start.character },
                            end: { line: s.location.range.end.line, character: s.location.range.end.character }
                        }
                    },
                    containerName: s.containerName
                })),
                fileModTimes: Array.from(this.fileModTimes.entries()),
                lastWorkspaceRefresh: this.lastWorkspaceRefresh
            };
            fs.writeFileSync(this.cachePath, JSON.stringify(data));
        } catch {
            // ignore save errors
        }
    }

    private setupDocumentChangeListener(): void {
        this.subscriptions.push(workspace.onDidChangeTextDocument((event) => {
            const uri = event.document.uri.toString();
            this.documentSymbols.delete(uri);
            this.fileModTimes.set(uri, event.document.version);
        }));

        this.subscriptions.push(workspace.onDidCloseTextDocument((doc) => {
            const uri = doc.uri.toString();
            this.documentSymbols.delete(uri);
            this.fileModTimes.delete(uri);
        }));
    }

    private startPeriodicRefresh(): void {
        console.log('Starting periodic refresh, interval:', this.workspaceRefreshInterval);
        this.refreshInterval = setInterval(async () => {
            console.log('Triggering periodic refresh');
            try {
                await this.refreshWithProgress();
            } catch (e) {
                console.error('Symbol refresh error:', e);
            }
        }, this.workspaceRefreshInterval);
    }

    private async refreshDocumentSymbols(): Promise<void> {
        const documents = workspace.textDocuments;
        const docsToProcess: { doc: typeof documents[0], uri: string }[] = [];
        
        for (const doc of documents) {
            if (doc.languageId === 'hlsl') {
                const uri = doc.uri.toString();
                const lastMod = this.fileModTimes.get(uri);
                if (!lastMod || lastMod < doc.version) {
                    docsToProcess.push({ doc, uri });
                }
            }
        }

        let startTime = Date.now();
        
        for (let i = 0; i < docsToProcess.length; i++) {
            const { doc, uri } = docsToProcess[i];
            try {
                const symbols = await commands.executeCommand<SymbolInformation[]>(
                    'vscode.executeDocumentSymbolProvider',
                    doc.uri
                );
                const existing = this.documentSymbols.get(uri) || [];
                const existingKeys = new Set(existing.map(s => `${s.location.uri.toString()}:${s.location.range.start.line}:${s.name}`));
                const newSymbols = (symbols || []).filter(s => !existingKeys.has(`${s.location.uri.toString()}:${s.location.range.start.line}:${s.name}`));
                this.documentSymbols.set(uri, [...existing, ...newSymbols]);
            } catch {
                // keep existing symbols on error
            }
            
            if (Date.now() - startTime >= this.refreshTimeSlice) {
                await new Promise(resolve => setTimeout(resolve, 0));
                startTime = Date.now();
            }
        }
    }

    private async refreshWorkspaceSymbols(): Promise<void> {
        try {
            console.log('refreshWorkspaceSymbols: current symbols:', this.workspaceSymbols.length);

            console.log('refreshWorkspaceSymbols: calling executeWorkspaceSymbolProvider');
            const symbols = await commands.executeCommand<SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                ''
            ) || [];
            
            const uniqueFiles = new Set(symbols.map(s => s.location.uri.toString()));
            console.log('refreshWorkspaceSymbols: got', symbols.length, 'symbols from', uniqueFiles.size, 'files');

            symbols.sort((a, b) => {
                const uriA = a.location.uri.toString();
                const uriB = b.location.uri.toString();
                const timeA = this.processedFileTimestamps.get(uriA) || 0;
                const timeB = this.processedFileTimestamps.get(uriB) || 0;
                return timeA - timeB;
            });

            const currentTime = Date.now();
            const newSymbols: SymbolInformation[] = [];
            
            for (const symbol of symbols) {
                const uri = symbol.location.uri.toString();
                const lastProcessed = this.processedFileTimestamps.get(uri);
                if (!lastProcessed || !this.fileModTimes.has(uri) || this.fileModTimes.get(uri)! > lastProcessed) {
                    newSymbols.push(symbol);
                }
            }
            
            console.log('refreshWorkspaceSymbols: new symbols:', newSymbols.length);
            
            if (newSymbols.length > 0) {
                await this.processSymbolsInChunks(newSymbols, true);
                
                for (const symbol of newSymbols) {
                    this.processedFileTimestamps.set(symbol.location.uri.toString(), currentTime);
                }
                
                console.log('refreshWorkspaceSymbols: total workspace symbols now:', this.workspaceSymbols.length);
            } else {
                console.log('refreshWorkspaceSymbols: no new symbols to process');
            }
            
            this.lastWorkspaceRefresh = Date.now();
        } catch (e) {
            console.error('refreshWorkspaceSymbols error:', e);
        }
    }

    private async processSymbolsInChunks(symbols: SymbolInformation[], saveAfterChunk: boolean = false): Promise<void> {
        console.log('processSymbolsInChunks: called with', symbols.length, 'symbols');
        
        const existingKeys = new Set(this.workspaceSymbols.map(s => `${s.location.uri.toString()}:${s.location.range.start.line}:${s.name}`));
        let startTime = Date.now();
        
        for (const symbol of symbols) {
            const key = `${symbol.location.uri.toString()}:${symbol.location.range.start.line}:${symbol.name}`;
            if (!existingKeys.has(key)) {
                this.workspaceSymbols = [...this.workspaceSymbols, symbol];
                existingKeys.add(key);
            }
            
            if (Date.now() - startTime >= this.refreshTimeSlice) {
                const uniqueFiles = new Set(this.workspaceSymbols.map(s => s.location.uri.toString()));
                console.log('processSymbolsInChunks: processed, total files so far:', uniqueFiles.size);
                
                if (saveAfterChunk) {
                    this.save();
                }
                
                await new Promise(resolve => setTimeout(resolve, 0));
                startTime = Date.now();
            }
        }
        
        const elapsed = Date.now() - startTime;
        console.log('processSymbolsInChunks: loop finished, elapsed:', elapsed);
        
        if (elapsed < this.refreshTimeSlice && symbols.length > 0) {
            await new Promise(resolve => setTimeout(resolve, this.refreshTimeSlice - elapsed));
        }
        
        if (saveAfterChunk) {
            this.save();
        }
    }

    async getDocumentSymbols(document: TextDocument): Promise<SymbolInformation[]> {
        const uri = document.uri.toString();
        let symbols = this.documentSymbols.get(uri);

        if (!symbols) {
            symbols = await commands.executeCommand<SymbolInformation[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            ) || [];
            this.documentSymbols.set(uri, symbols);
            this.fileModTimes.set(uri, document.version);
        }

        return symbols;
    }

    async findSymbol(name: string, document?: TextDocument): Promise<SymbolInformation | null> {
        if (document) {
            const symbols = await this.getDocumentSymbols(document);
            for (const symbol of symbols) {
                if (symbol.name === name) {
                    return symbol;
                }
            }
        }

        for (let i = this.workspaceSymbols.length - 1; i >= 0; i--) {
            const symbol = this.workspaceSymbols[i];
            if (symbol.name === name) {
                const uri = symbol.location.uri;
                const doc = workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                
                if (doc) {
                    const text = doc.getText();
                    const line = symbol.location.range.start.line;
                    const lineText = doc.lineAt(line).text;
                    if (!lineText.includes(name)) {
                        console.log(`findSymbol: removing stale symbol ${name} from cache`);
                        this.workspaceSymbols.splice(i, 1);
                        continue;
                    }
                }
                return symbol;
            }
        }

        return null;
    }

    async findSymbols(name: string): Promise<SymbolInformation[]> {
        const results: SymbolInformation[] = [];
        
        for (let i = this.workspaceSymbols.length - 1; i >= 0; i--) {
            const symbol = this.workspaceSymbols[i];
            if (symbol.name === name) {
                const uri = symbol.location.uri;
                const doc = workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                
                if (doc) {
                    const lineText = doc.lineAt(symbol.location.range.start.line).text;
                    if (!lineText.includes(name)) {
                        console.log(`findSymbols: removing stale symbol ${name} from cache`);
                        this.workspaceSymbols.splice(i, 1);
                        continue;
                    }
                }
                results.push(symbol);
            }
        }
        
        return results;
    }

    async provideWorkspaceSymbols(query: string): Promise<SymbolInformation[]> {
        if (!query) {
            return this.workspaceSymbols.slice();
        }
        const lower = query.toLowerCase();
        return this.workspaceSymbols.filter(s => s.name.toLowerCase().includes(lower));
    }

    async refreshWithProgress(): Promise<void> {
        if (this.workspaceRefreshPromise) {
            console.log('Refresh already in progress, waiting...');
            await this.workspaceRefreshPromise;
            return;
        }
        
        console.log('Starting symbol refresh with progress');
        const startTime = Date.now();
        
        this.workspaceRefreshPromise = (async () => {
            await window.withProgress({
                location: ProgressLocation.Window,
                title: 'Refreshing HLSL symbols',
                cancellable: true
            }, async (progress, cancellationToken) => {
                try {
                    progress.report({ message: 'Refreshing workspace symbols...', increment: 0 });
                    await this.refreshWorkspaceSymbols();
                    console.log('Workspace symbols refreshed:', this.workspaceSymbols.length);
                    
                    progress.report({ message: 'Refreshing document symbols...', increment: 50 });
                    await this.refreshDocumentSymbols();
                    console.log('Document symbols refreshed:', this.documentSymbols.size);
                    
                    progress.report({ message: 'Saving cache...', increment: 90 });
                    this.save();
                    
                    progress.report({ message: 'Done', increment: 100 });
                    console.log('Refresh complete in', Date.now() - startTime, 'ms');
                } catch (e) {
                    console.error('Refresh error:', e);
                    throw e;
                }
            });
        })();
        
        try {
            await this.workspaceRefreshPromise;
        } finally {
            this.workspaceRefreshPromise = null;
        }
    }

    dispose(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        this.subscriptions.forEach(s => s.dispose());
        this.save();
    }
}
