'use strict'

import { DefinitionProvider, ImplementationProvider, TypeDefinitionProvider, SymbolInformation, TextDocument, Position, Location, CancellationToken, Definition, workspace, commands } from 'vscode';


export default class HLSLDefinitionProvider implements DefinitionProvider, ImplementationProvider, TypeDefinitionProvider {

    private getDefinitionLocations(document: TextDocument, position: Position): Thenable<Location[]> {
        return new Promise<Location[]>((resolve, reject) => {
            
            let enable = workspace.getConfiguration('hlsl').get<boolean>('suggest.basic', true);
            if (!enable) {
                reject();
            }
            
            let wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                reject();
            }
            
            let name = document.getText(wordRange);

			let line = document.lineAt( position );
			let match = RegExp('^[\t ]*\#include \"([a-zA-Z/\\\.0-9]+)\"').exec(line.text);
			if( match )
			{
				let relativePath = workspace.findFiles( match[1], null, 1 ).then( files => {
					if( files && files.length > 0 )
					{
						let result: Location[] = [];
						result.push( new Location( files[0], new Position(0, 0)) );
						resolve(result);
					} else {
						reject();
					}
				} );
				return;
			}
            
            commands.executeCommand<SymbolInformation[]>('vscode.executeDocumentSymbolProvider', document.uri).then(symbols => {
                let result: Location[] = [];
                for (let symbol of symbols) {
                    if (symbol.name === name) {
                        result.push(symbol.location);
                    }
                }
				if( result.length == 0 )
				{
					commands.executeCommand<SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name).then(symbols => {
						for (let symbol of symbols) {
							if (symbol.name === name) {
								result.push(symbol.location);
							}
						}
						resolve(result);
					}, reason2 => reject(reason2));
				}
				else
				{
					resolve(result);
				}
            }, reason => reject(reason));
    
        });
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