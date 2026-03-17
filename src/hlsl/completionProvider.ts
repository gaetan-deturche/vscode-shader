'use strict';

import { CompletionItemProvider, CompletionItem, CompletionItemKind, CancellationToken, TextDocument, Position, Range, TextEdit, workspace, commands, SymbolInformation, SymbolKind } from 'vscode';
import hlslGlobals = require('./hlslGlobals');
import { SymbolCache } from './symbolCache';


export default class HLSLCompletionItemProvider implements CompletionItemProvider {
    private symbolCache: SymbolCache;

    constructor(symbolCache?: SymbolCache) {
        this.symbolCache = symbolCache || new SymbolCache();
    }

    public triggerCharacters = ['.'];

    public provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[]> {
        let result: CompletionItem[] = [];

        let enable = workspace.getConfiguration('hlsl').get<boolean>('suggest.basic', true);
        if (!enable) {
            return Promise.resolve(result);
        }

        var range = document.getWordRangeAtPosition(position);
        var prefix = range ? document.getText(range) : '';
        if (!range) {
            range = new Range(position, position);
        }

        var added: any = {};
        var createNewProposal = function (kind: CompletionItemKind, name: string, entry: hlslGlobals.IEntry, type?: string): CompletionItem {
            var proposal: CompletionItem = new CompletionItem(name);
            proposal.kind = kind;
            if (entry) {
                if (entry.description) {
                    proposal.documentation = entry.description;
                }
                if (entry.parameters) {
                    let signature = type ? '(' + type + ') ' : '';
                    signature += name;
                    signature += '(';
                    if (entry.parameters && entry.parameters.length != 0) {
                        let params = '';
                        entry.parameters.forEach(p => params += p.label + ',');
                        signature += params.slice(0, -1);
                    }
                    signature += ')';
                    proposal.detail = signature;
                }
            }
            return proposal;
        };

        var matches = (name: string) => {
            return prefix.length === 0 || name.length >= prefix.length && name.substr(0, prefix.length) === prefix;
        };

        for (var name in hlslGlobals.datatypes) {
            if (hlslGlobals.datatypes.hasOwnProperty(name) && matches(name)) {
                added[name] = true;
                result.push(createNewProposal(CompletionItemKind.TypeParameter, name, hlslGlobals.datatypes[name], 'datatype'));
            }
        }

        for (var name in hlslGlobals.intrinsicfunctions) {
            if (hlslGlobals.intrinsicfunctions.hasOwnProperty(name) && matches(name)) {
                added[name] = true;
                result.push(createNewProposal(CompletionItemKind.Function, name, hlslGlobals.intrinsicfunctions[name], 'function'));
            }
        }

        for (var name in hlslGlobals.semantics) {
            if (hlslGlobals.semantics.hasOwnProperty(name) && matches(name)) {
                added[name] = true;
                result.push(createNewProposal(CompletionItemKind.Reference, name, hlslGlobals.semantics[name], 'semantic'));
            }
        }

        for (var name in hlslGlobals.semanticsNum) {
            if (hlslGlobals.semanticsNum.hasOwnProperty(name) && matches(name)) {
                added[name] = true;
                result.push(createNewProposal(CompletionItemKind.Reference, name, hlslGlobals.semanticsNum[name], 'semantic'));
            }
        }

        for (var name in hlslGlobals.keywords) {
            if (hlslGlobals.keywords.hasOwnProperty(name) && matches(name)) {
                added[name] = true;
                result.push(createNewProposal(CompletionItemKind.Keyword, name, hlslGlobals.keywords[name], 'keyword'));
            }
        }

		return new Promise<CompletionItem[]>((resolve, reject) => {
			this.symbolCache.findSymbols("").then(symbols => {
				var ToCompletionItemKind = (kind: SymbolKind) => {
					switch(kind) 
					{
						case SymbolKind.File:
							return CompletionItemKind.File;
						case SymbolKind.Module:
							return CompletionItemKind.Module;
						case SymbolKind.Namespace:
							return CompletionItemKind.Module;
						case SymbolKind.Package:
							return CompletionItemKind.Module;
						case SymbolKind.Class:
							return CompletionItemKind.Class;
						case SymbolKind.Method:
							return CompletionItemKind.Method;
						case SymbolKind.Property:
							return CompletionItemKind.Property;
						case SymbolKind.Field:
							return CompletionItemKind.Field;
						case SymbolKind.Constructor:
							return CompletionItemKind.Constructor;
						case SymbolKind.Enum:
							return CompletionItemKind.Enum;
						case SymbolKind.Interface:
							return CompletionItemKind.Interface;
						case SymbolKind.Function:
							return CompletionItemKind.Function;
						case SymbolKind.Variable:
							return CompletionItemKind.Variable;
						case SymbolKind.Constant:
							return CompletionItemKind.Constant;
						case SymbolKind.Struct:
							return CompletionItemKind.Struct;
						case SymbolKind.Event:
							return CompletionItemKind.Event;
						case SymbolKind.Operator:
							return CompletionItemKind.Operator;
						case SymbolKind.TypeParameter:
							return CompletionItemKind.TypeParameter;
						default:
							return CompletionItemKind.Text;
					}
				}


				for (let symbol of symbols) {
					if( matches(symbol.name) ) {
						added[symbol.name] = true;
						result.push(createNewProposal(ToCompletionItemKind(symbol.kind), symbol.name, null, 'keyword'));
					}
				}

				var text = document.getText();
				var functionMatch = /^\w+\s+([a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*)\s*\(/mg;
				var match = null;
				while (match = functionMatch.exec(text)) {
					var word = match[1];
					if (!added[word]) {
						added[word] = true;
						result.push(createNewProposal(CompletionItemKind.Function, word, null));
					}
				}
				
				resolve(result);
			}, reason => reject(reason)) });
	}
}