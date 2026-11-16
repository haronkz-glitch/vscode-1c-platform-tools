import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { canonicalFileUri } from './identity';

/** Source read failures must not become ordinary rule failures. */
export class SourceDataError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'SourceDataError';
	}
}
export function sourceError(error: unknown, code = 'sourceReadFailed'): SourceDataError {
	if (error instanceof SourceDataError) { return error; }
	return new SourceDataError(code, error instanceof Error ? error.message : String(error));
}
export function assertSaved(uri: string): void {
	const key = canonicalFileUri(uri);
	if (vscode.workspace.textDocuments.some((document) =>
		document.uri.scheme === 'file' && canonicalFileUri(document.uri.toString()) === key && document.isDirty)) {
		throw new SourceDataError('dirtySource', 'Документ содержит несохранённые изменения.');
	}
}
/** File metadata is a cheap source revision. No full BSL read for descriptor-only rules. */
export async function persistedVersion(uri: string): Promise<string> {
	const canonical = canonicalFileUri(uri);
	assertSaved(canonical);
	const parsed = vscode.Uri.parse(canonical);
	let stat: import('node:fs').BigIntStats;
	try { stat = await fs.stat(parsed.fsPath, { bigint: true }); }
	catch (error) { throw sourceError(error); }
	assertSaved(canonical);
	if (!stat.isFile()) { throw new SourceDataError('unsupportedSource', 'Ожидался файл источника.'); }
	return JSON.stringify([stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
		stat.mtimeNs.toString(), stat.ctimeNs.toString()]);
}
/** Decode through the VS Code document model: it honours configured file encodings. */
export async function readPersisted(uri: string): Promise<{ text: string; version: string }> {
	const canonical = canonicalFileUri(uri);
	const start = await persistedVersion(canonical);
	const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(canonical));
	assertSaved(canonical);
	const version = document.version;
	const text = document.getText();
	if (document.isDirty || version !== document.version || await persistedVersion(canonical) !== start) {
		throw new SourceDataError('staleSource', 'Источник изменился во время чтения.');
	}
	return { text, version: start };
}
