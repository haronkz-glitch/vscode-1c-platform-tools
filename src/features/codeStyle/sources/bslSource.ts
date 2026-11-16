import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { sameOrUnder } from '../../../shared/projectLayout';
import { stableHash, targetCompare, targetKeyOf } from '../core/identity';
import { persistedVersion, readPersisted, SourceDataError } from '../core/sourceVersion';
import type {
	CodeStyleError, ProjectRef, SourceInventory, SourceProvider, SourceSelection, TargetDescriptor, TargetSnapshot,
} from '../core/types';
import {
	ensureSafeFile, filePath, fileUri, sourceForFile, sourceRoots, sameFile, type TrustedRoots,
} from './projectSource';

// The project-discovery exclusions contain Ext, but Ext holds real BSL modules.
const SKIP = new Set(['node_modules', 'oscript_modules', '.git', '.vscode', 'out', 'build', 'dist', 'target', 'coverage']);
function excludedDirectories(project: ProjectRef): ReadonlySet<string> {
	const cfg = vscode.workspace.getConfiguration('1c-platform-tools', vscode.Uri.file(project.root));
	const configured = cfg.get<string[]>('artifacts.exclude', []);
	const output = cfg.get<string>('path.out', 'build').replace(/\\/g, '/').replace(/^\.\/?/, '').split('/')[0];
	return new Set([...SKIP, output, ...configured
		.map((name) => name.replace(/\\/g, '/').replace(/^\.\/?|\/$/g, ''))
		.filter((name) => name !== '' && !name.includes('/'))].filter(Boolean));
}
function excluded(project: ProjectRef, directory: string, names: ReadonlySet<string>): boolean {
	const relative = path.relative(project.root, directory);
	if (relative.startsWith('..') || path.isAbsolute(relative)) { return true; }
	return relative.split(/[\\/]/).some((part) => part.startsWith('.') || names.has(part));
}
export async function fileFingerprint(file: string): Promise<string> {
	return persistedVersion(fileUri(file));
}
export class BslSourceProvider implements SourceProvider {
	readonly kind = 'bsl' as const;

	async enumerate(project: ProjectRef, selection: SourceSelection, token: vscode.CancellationToken): Promise<SourceInventory> {
		const targets: TargetDescriptor[] = [];
		const errors: CodeStyleError[] = [];
		const visited = new Set<string>();
		const names = excludedDirectories(project);
		const roots = sourceRoots(project).filter((root) => !selection.sourceKeys || selection.sourceKeys.includes(root.key));
		let complete = true;
		const error = (code: string, file: string, problem: unknown): void => {
			complete = false;
			errors.push({ code, projectKey: project.key, message: file + ': ' + String(problem) });
		};
		const add = async (file: string, known?: TrustedRoots): Promise<void> => {
			if (!/\.bsl$/i.test(file)) { return; }
			const source = sourceForFile(project, file);
			if (!source || !roots.some((root) => root.key === source.key) || excluded(project, path.dirname(file), names)) {
				return;
			}
			const targetKey = targetKeyOf(source, this.kind, file);
			if ((selection.files || selection.targetKeys) &&
				!selection.targetKeys?.includes(targetKey) &&
				!selection.files?.some((uri) => {
					const requested = filePath(uri);
					return requested !== undefined && sameFile(requested, file);
				})) { return; }
			try {
				await ensureSafeFile(project, file, source, known);
				if (!visited.has(targetKey)) {
					visited.add(targetKey);
					targets.push({
						projectKey: project.key, sourceKey: source.key, targetKey, sourceKind: this.kind,
						uri: fileUri(file), sourceRoot: source.root, format: source.format,
					});
				}
			} catch (problem) { error('bslFileUnavailable', file, problem); }
		};
		if (selection.files || selection.targetKeys) {
			const files = [...(selection.files ?? []), ...(selection.targetKeys ?? []).map((key) => {
				const marker = '|bsl|', at = key.lastIndexOf(marker);
				return at < 0 ? '' : fileUri(key.slice(at + marker.length));
			})];
			for (const uri of files) {
				if (token.isCancellationRequested) { complete = false; break; }
				const file = filePath(uri);
				if (file) { await add(file); }
			}
		} else {
			let realProject: string;
			try { realProject = await fs.realpath(project.root); }
			catch (problem) {
				return { targets: [], revision: '', complete: false,
					errors: [{ code: 'bslProjectUnavailable', projectKey: project.key, message: String(problem) }] };
			}
			for (const source of roots) {
				if (token.isCancellationRequested) { complete = false; break; }
				const seen = new Set<string>();
				let realSource: string;
				try {
					realSource = await fs.realpath(source.root);
					if (!sameOrUnder(realSource, realProject)) { throw new Error('Источник выходит за границы проекта.'); }
				} catch (problem) { error('bslSourceUnavailable', source.root, problem); continue; }
				const trusted: TrustedRoots = { projectReal: realProject, sourceReal: realSource };
				const walk = async (directory: string): Promise<void> => {
					if (token.isCancellationRequested) { complete = false; return; }
					let real: string;
					try {
						real = await fs.realpath(directory);
						if (!sameOrUnder(real, realSource)) { throw new Error('Ссылка выходит за границы источника.'); }
						if (seen.has(real)) { throw new Error('Повторный обход через символическую ссылку или цикл.'); }
						seen.add(real);
					} catch (problem) { error('bslDirectoryUnsafe', directory, problem); return; }
					let entries: import('node:fs').Dirent[];
					try { entries = await fs.readdir(directory, { withFileTypes: true }); }
					catch (problem) { error('bslEnumerate', directory, problem); return; }
					entries.sort((a, b) => a.name.localeCompare(b.name));
					for (const entry of entries) {
						if (token.isCancellationRequested) { complete = false; return; }
						const file = path.join(directory, entry.name);
						let isDir = entry.isDirectory(), isFile = entry.isFile();
						if (entry.isSymbolicLink()) {
							try {
								const stat = await fs.stat(file);
								isDir = stat.isDirectory();
								isFile = stat.isFile();
							} catch (problem) { error('bslSymlinkUnavailable', file, problem); continue; }
						}
						if (isDir) {
							if (!excluded(project, file, names) &&
								!project.excludedRoots.some((root) => sameOrUnder(file, root)) &&
								sourceForFile(project, file)?.key === source.key) { await walk(file); }
						} else if (isFile && /\.bsl$/i.test(file)) {
							await add(file, trusted);
						}
					}
				};
				await walk(source.root);
			}
		}
		targets.sort(targetCompare);
		return { targets, complete, errors, revision: stableHash(...targets.map((target) => target.targetKey)) };
	}

	async read(project: ProjectRef, target: TargetDescriptor, token: vscode.CancellationToken): Promise<TargetSnapshot> {
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		const file = filePath(target.uri);
		const source = file && sourceForFile(project, file);
		if (!file || !source || source.key !== target.sourceKey) {
			throw new SourceDataError('unsupportedSource', 'BSL-цель больше не принадлежит источнику.');
		}
		await ensureSafeFile(project, file, source);
		const snapshot = await readPersisted(target.uri);
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		return { kind: this.kind, uri: target.uri, version: snapshot.version, text: snapshot.text };
	}
}
