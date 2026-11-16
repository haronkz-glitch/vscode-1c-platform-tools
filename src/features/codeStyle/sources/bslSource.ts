import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { sameOrUnder } from '../../../shared/projectLayout';
import { stableHash, targetCompare, targetKeyOf } from '../core/identity';
import { SourceDataError } from '../core/sourceVersion';
import type { CodeStyleError, ProjectRef, SourceInventory, SourceProvider, SourceSelection, TargetDescriptor, TargetSnapshot } from '../core/types';
import { ensureSafeFile, filePath, fileUri, sourceForFile, sourceRoots, sameFile } from './projectSource';

// Layout discovery deliberately skips "Ext"; BSL scanning MUST NOT copy that exclusion.
const SKIP = new Set(['node_modules', 'oscript_modules', '.git', '.vscode', 'out', 'build', 'dist', 'target', 'coverage']);
function skipBslDirectory(project: ProjectRef, directory: string): boolean {
	const relative = path.relative(project.root, directory);
	if (relative.startsWith('..') || path.isAbsolute(relative)) { return true; }
	const cfg = vscode.workspace.getConfiguration('1c-platform-tools', vscode.Uri.file(project.root));
	const configured = cfg.get<string[]>('artifacts.exclude', []);
	const build = cfg.get<string>('path.out', 'build').replace(/\\/g, '/').replace(/^\.\/?/, '').split('/')[0];
	const exclusions = new Set([...SKIP, build, ...configured
		.map((value) => value.replace(/\\/g, '/').replace(/^\.\/?|\/$/g, ''))
		.filter((value) => value.length > 0 && !value.includes('/'))]);
	return relative.split(/[\\/]/).some((segment) => segment.startsWith('.') || exclusions.has(segment));
}
export async function fileFingerprint(file: string): Promise<string> {
	return createHash('sha1').update(await fs.readFile(file)).digest('hex');
}
export class BslSourceProvider implements SourceProvider {
	readonly kind = 'bsl' as const;

	async enumerate(project: ProjectRef, selection: SourceSelection, token: vscode.CancellationToken): Promise<SourceInventory> {
		const targets: TargetDescriptor[] = [];
		const errors: CodeStyleError[] = [];
		const visited = new Set<string>();
		let complete = true;
		const add = async (file: string): Promise<void> => {
			if (!file.toLowerCase().endsWith('.bsl')) { return; }
			const source = sourceForFile(project, file);
			if (!source || skipBslDirectory(project, path.dirname(file))) { return; }
			const requestedKey = targetKeyOf(source, this.kind, file);
			if ((selection.targetKeys || selection.files) &&
				!selection.targetKeys?.includes(requestedKey) &&
				!selection.files?.some((uri) => {
					const requested = filePath(uri);
					return requested !== undefined && sameFile(requested, file);
				})) { return; }
			try {
				await ensureSafeFile(project, file, source);
				const targetKey = targetKeyOf(source, this.kind, file);
				if (!visited.has(targetKey)) {
					visited.add(targetKey);
					targets.push({
						projectKey: project.key, sourceKey: source.key, targetKey, sourceKind: this.kind,
						uri: fileUri(file), sourceRoot: source.root, format: source.format,
					});
				}
			} catch (error) {
				complete = false;
				errors.push({ code: 'bslFileUnavailable', projectKey: project.key, message: String(error) });
			}
		};
		if (selection.files || selection.targetKeys) {
			const files = [...(selection.files ?? []), ...(selection.targetKeys ?? []).map((key) => {
				const marker = '|bsl|';
				const i = key.lastIndexOf(marker);
				return i < 0 ? '' : fileUri(key.slice(i + marker.length));
			})];
			for (const uri of files) {
				if (token.isCancellationRequested) { complete = false; break; }
				const file = filePath(uri);
				if (file) { await add(file); }
			}
		} else {
			const walk = async (directory: string): Promise<void> => {
				if (token.isCancellationRequested) { complete = false; return; }
				let entries: import('node:fs').Dirent[];
				try { entries = await fs.readdir(directory, { withFileTypes: true }); }
				catch (error) {
					complete = false;
					errors.push({ code: 'bslEnumerate', projectKey: project.key, message: String(error) });
					return;
				}
				entries.sort((a, b) => a.name.localeCompare(b.name));
				for (const entry of entries) {
					if (token.isCancellationRequested) { complete = false; return; }
					const file = path.join(directory, entry.name);
					if (entry.isDirectory()) {
						if (!entry.name.startsWith('.') && !SKIP.has(entry.name) &&
							!project.excludedRoots.some((excluded) => sameOrUnder(file, excluded)) && !skipBslDirectory(project, file)
							&& sourceForFile(project, file)) {
							await walk(file);
						}
					} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bsl')) {
						await add(file);
					}
				}
			};
			for (const root of sourceRoots(project)) {
				if (token.isCancellationRequested) { complete = false; break; }
				if (!sameOrUnder(root.root, project.root)) { continue; }
				try {
					const [realProject, realSource] = await Promise.all([
						fs.realpath(project.root), fs.realpath(root.root),
					]);
					if (!sameOrUnder(realSource, realProject)) {
						throw new Error('Корень BSL-источника выходит за границу проекта.');
					}
					await walk(root.root);
				} catch (error) {
					complete = false;
					errors.push({ code: 'bslSourceUnavailable', projectKey: project.key, message: String(error) });
				}
			}
		}
		targets.sort(targetCompare);
		return { targets, complete, errors, revision: stableHash(...targets.map((t) => t.targetKey)) };
	}

	async read(project: ProjectRef, target: TargetDescriptor, token: vscode.CancellationToken): Promise<TargetSnapshot> {
		if (token.isCancellationRequested) { throw new Error('Операция отменена.'); }
		const file = filePath(target.uri);
		const source = file && sourceForFile(project, file);
		if (!file || !source || source.key !== target.sourceKey) { throw new Error('BSL-цель больше не принадлежит источнику.'); }
		const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === target.uri);
		if (open?.isDirty) { throw new SourceDataError('dirtySource', 'Файл BSL не сохранён.'); }
		await ensureSafeFile(project, file, source);
		const bytes = await fs.readFile(file);
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		if (open?.isDirty) { throw new SourceDataError('dirtySource', 'Файл BSL изменён в редакторе.'); }
		return {
			kind: this.kind, uri: target.uri,
			version: createHash('sha1').update(bytes).digest('hex'),
			text: bytes.toString('utf8'),
		};
	}
}
