import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	externalDirectory, externalEntry, resolveProjectLayout, sameOrUnder, sourceEntry,
	type ExternalRoot, type SourceRoot,
} from '../../../shared/projectLayout';
import {
	listCandidates, listProjects, projectRootKey, projectsSnapshot,
	type ProjectCandidate, type WorkspaceProject,
} from '../../../shared/workspaceProjects';
import { keyOfPath, projectKeyOf, sourceKeyOf } from '../core/identity';
import type { ProjectRef, SourceRef } from '../core/types';

type KnownRoot = { root: string; candidate: boolean; configuration?: SourceRoot };

async function knownProjects(): Promise<KnownRoot[]> {
	const snapshot = projectsSnapshot();
	const resolved = snapshot.complete
		? snapshot
		: { projects: await listProjects(), candidates: await listCandidates() };
	const projects = resolved.projects;
	const candidates = resolved.candidates;
	const refs: KnownRoot[] = [
		...projects.map((item: WorkspaceProject) => ({ root: item.root, candidate: false, configuration: item.configuration })),
		...candidates.map((item: ProjectCandidate) => ({ root: item.root, candidate: true, configuration: item.configuration })),
	];
	return refs.filter((ref, index) => refs.findIndex((other) => projectRootKey(other.root) === projectRootKey(ref.root)) === index);
}
function mostSpecific(known: readonly KnownRoot[], file: string): KnownRoot | undefined {
	return known.filter((ref) => sameOrUnder(file, ref.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
}
async function makeProject(ref: KnownRoot, known: readonly KnownRoot[]): Promise<ProjectRef> {
	const excludedRoots = known.filter((other) =>
		projectRootKey(other.root) !== projectRootKey(ref.root) && sameOrUnder(other.root, ref.root)
	).map((other) => path.resolve(other.root));
	const layout = await resolveProjectLayout(ref.root);
	const rootConfiguration = ref.configuration;
	if (rootConfiguration && (!layout.configuration || (ref.candidate && !sameOrUnder(layout.configuration.dir, ref.root)))) {
		return { key: projectKeyOf(ref.root), root: path.resolve(ref.root), candidate: ref.candidate, excludedRoots, layout: { ...layout, configuration: rootConfiguration } };
	}
	return { key: projectKeyOf(ref.root), root: path.resolve(ref.root), candidate: ref.candidate, excludedRoots, layout };
}
/** Never silently fall back to the active project or workspace folder. */
export async function projectByExplicitRoot(root: string): Promise<ProjectRef | undefined> {
	const known = await knownProjects();
	const exact = known.find((entry) => projectRootKey(entry.root) === projectRootKey(root));
	return exact ? makeProject(exact, known) : undefined;
}
export async function projectForFile(uri: string): Promise<ProjectRef | undefined> {
	const parsed = vscode.Uri.parse(uri);
	if (parsed.scheme !== 'file') { return undefined; }
	const known = await knownProjects();
	const ref = mostSpecific(known, parsed.fsPath);
	return ref ? makeProject(ref, known) : undefined;
}
export async function projectsForWorkspace(): Promise<readonly ProjectRef[]> {
	const known = await knownProjects();
	return Promise.all(known.map((ref) => makeProject(ref, known)));
}

function sourceFromConfiguration(project: ProjectRef, root: SourceRoot): SourceRef {
	const candidate: Omit<SourceRef, 'projectKey' | 'key'> = {
		root: path.resolve(root.dir), kind: root.isExtension ? 'extension' : 'configuration',
		format: root.format, entry: sourceEntry(root),
	};
	return { ...candidate, projectKey: project.key, key: sourceKeyOf(project, candidate) };
}
function sourceFromExternal(project: ProjectRef, root: ExternalRoot): SourceRef {
	const candidate: Omit<SourceRef, 'projectKey' | 'key'> = {
		root: externalDirectory(root), kind: root.kind, format: root.format, entry: externalEntry(root),
	};
	return { ...candidate, projectKey: project.key, key: sourceKeyOf(project, candidate) };
}
/** The original ProjectLayout defines all supported roots, including test and external roots. */
export function sourceRoots(project: ProjectRef): readonly SourceRef[] {
	const layout = project.layout;
	const configurations = [
		...(layout.configuration ? [layout.configuration] : []),
		...layout.others, ...layout.extensions, ...layout.testExtensions,
	];
	const externals = [...layout.processors, ...layout.reports, ...layout.testProcessors];
	const sources = [...configurations.map((root) => sourceFromConfiguration(project, root)),
		...externals.map((root) => sourceFromExternal(project, root))];
	const unique = new Map(sources.filter((source) =>
		sameOrUnder(source.root, project.root)
			&& !project.excludedRoots.some((root) => sameOrUnder(source.root, root))
	).map((source) => [source.key, source]));
	return [...unique.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/** The most specific source wins when roots happen to be nested. */
export function sourceForFile(project: ProjectRef, file: string): SourceRef | undefined {
	if (project.excludedRoots.some((root) => sameOrUnder(file, root))) { return undefined; }
	return [...sourceRoots(project)].filter((root) => sameOrUnder(file, root.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
}
export function fileUri(file: string): string { return vscode.Uri.file(file).toString(); }
export function filePath(uri: string): string | undefined {
	try {
		const parsed = vscode.Uri.parse(uri);
		return parsed.scheme === 'file' ? parsed.fsPath : undefined;
	} catch { return undefined; }
}
/** Both lexical and real paths must remain inside the selected project/source boundary. */
export async function ensureSafeFile(project: ProjectRef, file: string, source?: SourceRef): Promise<void> {
	if (!sameOrUnder(file, project.root) || (source && !sameOrUnder(file, source.root))) {
		throw new Error('Файл вне разрешённой области проекта.');
	}
	const [projectReal, fileReal, sourceReal] = await Promise.all([
		fs.realpath(project.root), fs.realpath(file), source ? fs.realpath(source.root) : Promise.resolve(undefined),
	]);
	if (!sameOrUnder(fileReal, projectReal) || (sourceReal && (!sameOrUnder(sourceReal, projectReal) || !sameOrUnder(fileReal, sourceReal)))) {
		throw new Error('Символическая ссылка выходит за разрешённую область проекта.');
	}
	const stat = await fs.stat(fileReal);
	if (!stat.isFile()) { throw new Error('Ожидался обычный файл.'); }
}
export async function ensureOwnedUri(project: ProjectRef, uri: string): Promise<string> {
	const file = filePath(uri);
	if (!file || !sourceForFile(project, file)) { throw new Error('URI не относится к источникам проекта.'); }
	await ensureSafeFile(project, file, sourceForFile(project, file));
	return file;
}
export function sameFile(left: string, right: string): boolean { return keyOfPath(left) === keyOfPath(right); }
