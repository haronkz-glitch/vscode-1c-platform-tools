import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

/** A code and safe text survive across the engine/store boundary; stacks belong to the logger. */
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
	const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri);
	if (document?.isDirty) { throw new SourceDataError('dirtySource', 'Документ содержит несохранённые изменения.'); }
}

export function fingerprint(bytes: Uint8Array): string {
	return createHash('sha1').update(bytes).digest('hex');
}
export async function readPersisted(uri: string): Promise<{ bytes: Buffer; version: string }> {
	const parsed = vscode.Uri.parse(uri);
	if (parsed.scheme !== 'file') { throw new SourceDataError('unsupportedSource', 'Ожидается файловый URI.'); }
	assertSaved(uri);
	let bytes: Buffer;
	try { bytes = await fs.readFile(parsed.fsPath); }
	catch (error) { throw sourceError(error, 'sourceReadFailed'); }
	assertSaved(uri);
	return { bytes, version: fingerprint(bytes) };
}
/** A checked source version must correspond to actual bytes, not a run start timestamp. */
export async function persistedVersion(uri: string): Promise<string> {
	return (await readPersisted(uri)).version;
}
