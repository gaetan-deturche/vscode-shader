'use strict'

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as Path from 'path';
import * as tmp from 'tmp';

import { setRgPath, setHlslExtensions } from './common'

import HLSLHoverProvider from './hlsl/hoverProvider';
import HLSLCompletionItemProvider from './hlsl/completionProvider';
import HLSLSignatureHelpProvider from './hlsl/signatureProvider';
import HLSLSymbolProvider from './hlsl/symbolProvider';
import HLSLDefinitionProvider from './hlsl/definitionProvider';
import HLSLReferenceProvider from './hlsl/referenceProvider';
import { SymbolCache } from './hlsl/symbolCache';

class HLSLFormatingProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {

    public async provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken): Promise<vscode.TextEdit[]> {
        var tmpFile = tmp.fileSync({prefix: 'hlsl-', postfix: '.cpp'});
        fs.writeFileSync(tmpFile.name, document.getText());

        let doc = await vscode.workspace.openTextDocument(tmpFile.name);
        return vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, options)
            .then(r => (tmpFile.removeCallback(), r));
    }

    public async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): Promise<vscode.TextEdit[]> {

        var tmpFile = tmp.fileSync({prefix: 'hlsl-', postfix: '.cpp'});
        fs.writeFileSync(tmpFile.name, document.getText());

        let doc = await vscode.workspace.openTextDocument(tmpFile.name);
        return vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatRangeProvider', doc.uri, range, options)
            .then(r => (tmpFile.removeCallback(), r));
    }

}

const documentSelector = [
    { language: 'hlsl', scheme: 'file' },
    { language: 'hlsl', scheme: 'untitled' },
];

function searchRgPath()
{
    function exeName() {
        const isWin = /^win/.test( process.platform );
        return isWin ? "rg.exe" : "rg";
    }

    function exePathIsDefined( rgExePath ) {
        return fs.existsSync( rgExePath ) ? rgExePath : undefined;
    }

    let rgPath = "";

    rgPath = exePathIsDefined( Path.join( vscode.env.appRoot, "node_modules/vscode-ripgrep/bin/", exeName() ) );
    if( rgPath ) {
        return rgPath;
    }

	rgPath = exePathIsDefined( Path.join( vscode.env.appRoot, "node_modules/@vscode/ripgrep/bin/", exeName() ) );
	if( rgPath ) {
        return rgPath;
    }

    // If vscode-ripgrep is in an .asar file, then the binary is unpacked.
    rgPath = exePathIsDefined( Path.join( vscode.env.appRoot, "node_modules.asar.unpacked/vscode-ripgrep/bin/", exeName() ) );
    if( rgPath ) {
        return rgPath;
    }

	rgPath = exePathIsDefined( Path.join( vscode.env.appRoot, "node_modules.asar.unpacked/@vscode/ripgrep/bin/", exeName() ) );
    if( rgPath ) {
        return rgPath;
    }

    return rgPath;
}

export async function activate(context: vscode.ExtensionContext) {

    console.log('vscode-shader extension started');

    const rgDiskPath = searchRgPath();
    if (!rgDiskPath) {
        console.log("vscode-shader couldn't find vscode-ripgrep binary path");
    }
    setRgPath(rgDiskPath);


    const associations = vscode.workspace.getConfiguration('files.associations');
    for (const fileType of Object.keys(associations)){
        if(associations[fileType]  === 'hlsl')
        {
            setHlslExtensions(fileType.substring(1));
        }
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const cachePath = wsFolder ? Path.join(wsFolder.uri.fsPath, '.vs', 'symbol-cache.json') : '';
    console.log('Creating SymbolCache with path:', cachePath);
    const symbolCache = new SymbolCache(cachePath);

    context.subscriptions.push(vscode.commands.registerCommand('shader.refreshSymbols', async () => {
        console.log('Manual refresh symbols command triggered');
        await symbolCache.refreshWithProgress();
    }));

    // add providers
    context.subscriptions.push(vscode.languages.registerHoverProvider(documentSelector, new HLSLHoverProvider(symbolCache)));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(documentSelector, new HLSLCompletionItemProvider(symbolCache), '.'));
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(documentSelector, new HLSLSignatureHelpProvider(), '(', ','));
    context.subscriptions.push(vscode.languages.registerReferenceProvider(documentSelector, new HLSLReferenceProvider(symbolCache)));

    let symbolProvider = new HLSLSymbolProvider();
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(documentSelector, symbolProvider));
    context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(symbolProvider));

    let definitionProvider = new HLSLDefinitionProvider(symbolCache);
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(documentSelector, definitionProvider));
    context.subscriptions.push(vscode.languages.registerImplementationProvider(documentSelector, definitionProvider));
    context.subscriptions.push(vscode.languages.registerTypeDefinitionProvider(documentSelector, definitionProvider));

    context.subscriptions.push({
        dispose: () => {
            symbolCache.dispose();
        }
    });

    if (vscode.extensions.getExtension('ms-vscode.cpptools') !== undefined) {
        let formatingProvider = new HLSLFormatingProvider();
        context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(documentSelector, formatingProvider));
        context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(documentSelector, formatingProvider));
    }

}
