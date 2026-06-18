'use strict';

import { DocumentSymbolProvider, WorkspaceSymbolProvider, SymbolKind, SymbolInformation, CancellationToken, TextDocument, Position, Range, RelativePattern, Location, Uri, Disposable, window, workspace, extensions } from 'vscode';
import { rgPath, hlslExtensions, getHlslExtensions } from '../common';
import { ISymbolBackend } from './symbolBackend';
import { execSync } from 'child_process';
import { join } from 'path';

interface ISymbolPattern { kind: SymbolKind, pattern: string }

const searchPatterns: ISymbolPattern[] = [
    { kind: SymbolKind.Function, pattern: /^[\t ]*(?:void|bool|int|uint|half|float|double|float2|float3|float4|float2x2|float3x3|float4x4|int2|int3|int4|uint2|uint3|uint4|bool2|bool3|bool4|half2|half3|half4|double2|double3|double4|[a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_\x7f-\xff][a-zA-Z0-9:_\x7f-\xff]*)\s*\([^)]*\)(?!;)/.source },
    { kind: SymbolKind.Struct, pattern: /^[\t ]*(?:struct|cbuffer|tbuffer|ConstantBuffer)[\t ]+([a-zA-Z_\x7f-\xff][a-zA-Z0-9:_\x7f-\xff]*)/.source },
    { kind: SymbolKind.Variable, pattern: /^[\t ]*(?:globallycoherent|\t| |static|uniform|groupshared)*(?:sampler|sampler1D|sampler2D|sampler3D|samplerCUBE|samplerRECT|sampler_state|SamplerState|SamplerComparisonState)[\t ]+([a-zA-Z_\x7f-\xff][a-zA-Z0-9:_\x7f-\xff]*)/.source },
	{ kind: SymbolKind.Variable, pattern: /^.*(?:float|int|bool)(?:[1-4](?:x[1-4])?)?[\t ]+([a-zA-Z_][a-zA-Z0-9_]*)[^\(]/.source },
    { kind: SymbolKind.Field, pattern: /^[\t ]*(?:globallycoherent|\t| |static|uniform)*(?:texture|texture2D|textureCUBE|Texture1D|Texture1DArray|Texture2D|Texture2DArray|Texture2DMS|Texture2DMSArray|Texture2DMultisample|Texture3D|TextureCube|TextureCubeArray|RWTexture1D|RWTexture1DArray|RWTexture2D|RWTexture2DArray|RWTexture3D|TextureRenderTarget2D|RenderTarget2D|RenderTargetCube)(?:[\t ]*<(?:[a-zA-Z_][a-zA-Z0-9,_]*)>)?[\t ]+([a-zA-Z_][a-zA-Z0-9\[\]_]*)/.source },
    { kind: SymbolKind.Field, pattern: /^[\t ]*(?:AppendStructuredBuffer|Buffer|ByteAddressBuffer|ConsumeStructuredBuffer|RWBuffer|RWByteAddressBuffer|RWStructuredBuffer|StructuredBuffer)(?:[\t ]*<(?:[a-zA-Z_\x7f-\xff][a-zA-Z0-9,_\x7f-\xff]*)>)?[\t ]+([a-zA-Z_\x7f-\xff][a-zA-Z0-9\[\]_\x7f-\xff]*)/.source },
	{ kind: SymbolKind.Function, pattern: /^[\t ]*\#define[\t ]+([a-zA-Z_\x7f-\xff][a-zA-Z0-9:_\x7f-\xff]*)\(/.source },
	/*{ kind: SymbolKind.Field, pattern: /^[\t ]*(?:globallycoherent|\t| |static|uniform)*DECLARE_[A-Z0-9_]*\(\s+([a-zA-Z_][a-zA-Z0-9_]*)/.source },*/
];

export interface ISymbolCache { [path: string]: SymbolInformation[]; }

export default class HLSLDocumentSymbolProvider implements DocumentSymbolProvider, WorkspaceSymbolProvider {

    private _disposables: Disposable[] = [];

    private _hlslPattern: string[];

    // When an AST backend is active, document/workspace symbol production is
    // delegated to it instead of the regex/ripgrep path below.
    private _backend?: ISymbolBackend;
    private _useAst: boolean;

    constructor(backend?: ISymbolBackend, useAst: boolean = false) {
        this._hlslPattern = getHlslExtensions();
        this._backend = backend;
        this._useAst = useAst && !!backend;
    }

    public dispose(){
        if (this._disposables.length > 0) {
            this._disposables.forEach(d => d.dispose());
            this._disposables = [];
        }
    }

    private getDocumentSymbols(uri: Uri): Promise<SymbolInformation[]> {
        return new Promise<SymbolInformation[]>((resolve, reject) => {
            let result: SymbolInformation[] = [];

            let document: TextDocument = null;
            for (let d of workspace.textDocuments) {
                if (d.uri.toString() === uri.toString()) {
                    document = d;
                    break;
                }
            }

            if (document === null) {
                resolve([]);
                return;
            }

            let text = document.getText();

            function fetchSymbol(entry: ISymbolPattern) {
                const kind = entry.kind;
                const pattern = entry.pattern;

                let regex = new RegExp(pattern, "gm");
                let match: RegExpExecArray = null;
                while (match = regex.exec(text)) {
                    let line = document.positionAt(match.index).line;
                    let range = document.lineAt(line).range;
                    let word = match[1];
					let wordPos = match[0].indexOf(word);
					range = new Range(range.start.translate(0, wordPos), range.start.translate(0, wordPos + word.length));
                    result.push(new SymbolInformation(word, kind, '', new Location(document.uri, range)));
                }
            }

            for (let entry of searchPatterns) {
                fetchSymbol(entry);
            }

            resolve(result);

        });
    }

    public provideDocumentSymbols(document: TextDocument, token: CancellationToken): Thenable<SymbolInformation[]> {
        if (this._useAst && this._backend) {
            return this._backend.getDocumentSymbols(document);
        }
        return this.getDocumentSymbols(document.uri);
    }

    private getDocument(): TextDocument | undefined {
        // we wants to have a resource even when asking
        // general questions so we check the active editor. If this
        // doesn't match we take the first TS document.

        const activeDocument = window.activeTextEditor?.document;
        if (activeDocument) {
            if (activeDocument.languageId == 'hlsl') {
                return activeDocument;
            }
        }

        const documents = workspace.textDocuments;
        console.log('getDocument: checking', documents.length, 'documents');
        for (const document of documents) {
            if (document.languageId == 'hlsl') {
                console.log('getDocument: found hlsl document:', document.uri.toString());
                return document;
            }
        }
        console.log('getDocument: no hlsl document found');
        return undefined;
    }

    public provideWorkspaceSymbols(query: string, token: CancellationToken): Thenable<SymbolInformation[]> {
        if (this._useAst && this._backend) {
            return this._backend.provideWorkspaceSymbols(query);
        }

        console.log('provideWorkspaceSymbols called with query:', query, 'rgPath:', rgPath);

        if (!rgPath) {
            console.log('provideWorkspaceSymbols: no rgPath, returning empty');
            return Promise.resolve([]);
        }
        
        return new Promise<SymbolInformation[]>((resolve, reject) => {
            let results: SymbolInformation[] = [];

            const document = this.getDocument();
            console.log('provideWorkspaceSymbols: document:', document?.uri.toString());
            
            if (!document){
                resolve( results );
                return;
            }

            const ws = workspace.getWorkspaceFolder(document.uri);
            if (!ws) {
                console.log('provideWorkspaceSymbols: no workspace folder');
                resolve(results);
                return;
            }

            const rootPath = ws.uri.fsPath;
            const execOpts = {
                cwd: rootPath,
                maxBuffer: 1024 * 1024 * 500
            }

            let includePattern = '-g *' +  this._hlslPattern.join(' -g *'); 

            for (let entry of searchPatterns) {
                const kind = entry.kind;
                const searchPattern = entry.pattern;
                let output: string | Buffer = "";
				try
				{
					output = execSync(`"${rgPath}" ${includePattern} -o --case-sensitive -H --line-number --column --pcre2 --hidden -e "${searchPattern}" .`, execOpts);
				}
				catch(error)
				{
					console.log(error);
				}

                let lines = output.toString().split('\n');
                for (let line of lines) {
                    let lineMatch = /^(?:((?:[a-zA-Z]:)?[^:]*):)?(\d+):(\d):(.+)/.exec(line);
                    if (lineMatch) {
                        let position: Position = new Position(parseInt(lineMatch[2]) - 1, parseInt(lineMatch[3]) - 1);
                        let range = new Range(position, position);
                        let filepath = join(rootPath, lineMatch[1]);
                        let regex = new RegExp(searchPattern);
                        let word = '?????';
                        let symbolMatch = regex.exec(lineMatch[4].toString());
                        if (symbolMatch) {
                            word = symbolMatch[1];
                            position = position.with({ character: symbolMatch[0].indexOf(word) });
                            range = new Range(position, position.translate(0, word.length));
                        }

                        results.push(new SymbolInformation(word, kind, '', new Location(Uri.file(filepath), range)));
                    }
                }
            }

            resolve( results );
        });

    }

}
