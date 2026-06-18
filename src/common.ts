
import { extensions } from 'vscode';

export var rgPath: string = '';
export var hlslExtensions: string[] = [];

export function setRgPath(path: string) {
	rgPath = path;
}

export function getRgPath() {
	return rgPath;
}

export function setHlslExtensions(ext: string) {
	hlslExtensions.push(ext);
}

/**
 * The authoritative list of file extensions (including the leading dot) that
 * are treated as HLSL. Combines a base list, the extensions contributed by the
 * built-in `vscode.hlsl` language, and any `files.associations` the user mapped
 * to hlsl (collected into `hlslExtensions`). Shared by every symbol backend so
 * file discovery is consistent.
 */
export function getHlslExtensions(): string[] {
	let result = ['.hlsl', '.hlsli', '.fx', '.fxh', '.vsh', '.psh', '.cginc', '.compute', '.ush', '.usf'];

	const extension = extensions.getExtension('vscode.hlsl');
	if (extension && extension.packageJSON
		&& extension.packageJSON.contributes
		&& extension.packageJSON.contributes.languages) {
		let hlsllang: any[] = extension.packageJSON.contributes.languages.filter(l => l.id === 'hlsl');
		if (hlsllang.length && hlsllang[0].extensions) {
			result = result.concat(hlsllang[0].extensions.slice());
		}
	}

	result = result.concat(hlslExtensions);

	// Keep only unique entries
	return [...new Set(result)];
}
