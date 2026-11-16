import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createTestWorkspace, cleanupTestWorkspace } from '../fixtures/helpers/testWorkspace';
import { projectKeyOf, targetKeyOf } from '../../features/codeStyle/core/identity';
import { sourceRoots, fileUri } from '../../features/codeStyle/sources/projectSource';
import { persistedVersion } from '../../features/codeStyle/core/sourceVersion';
import { IssueStore } from '../../features/codeStyle/core/issueStore';
import type { ProjectRef, RuleDefinition, Issue, TargetDescriptor } from '../../features/codeStyle/core/types';
export const token = new vscode.CancellationTokenSource().token;
export const rule = (id = 'test-a', patch: Partial<RuleDefinition> = {}): RuleDefinition => ({
	id, title: 'Тестовые данные', description: 'Тестовые данные', area: 'bsl', category: 'style',
	defaultEnabled: true, defaultSeverity: 'warning', sourceKinds: ['bsl'], check: () => [], ...patch,
});
export const effective = { enabled: true, severity: 'warning' as const, options: {}, revision: 'r1' };
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
export async function environment() {
	const root = await createTestWorkspace({ template: 'empty-project' });
	const dir = path.join(root, 'configuration');
	await fs.mkdir(dir);
	const project: ProjectRef = { key: projectKeyOf(root), root, candidate: true, excludedRoots: [], layout: {
			configuration: { dir, format: 'designer', name: 'Test', isExtension: false },
			others: [], extensions: [], testExtensions: [], processors: [], reports: [], testProcessors: [], externals: [], subProjects: [],
		} };
	const write = async (name: string, text = 'Тестовые данные') => {
		const file = path.join(dir, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
		return file;
	};
	await write('Configuration.xml', '<configuration/>');
	const file = await write('CommonModules/Test/Ext/Module.bsl');
	const source = sourceRoots(project)[0];
	const target: TargetDescriptor = { projectKey: project.key, sourceKey: source.key,
		targetKey: targetKeyOf(source, 'bsl', file), sourceKind: 'bsl', uri: fileUri(file), sourceRoot: dir, format: 'designer' };
	const store = new IssueStore();
	store.setRuleRevisions(project.key, { 'test-a': 'r1', 'test-b': 'r1' });
	const issue = (id = 'one', ruleId = 'test-a'): Issue => ({ id, ruleId, area: 'bsl', category: 'style', severity: 'warning',
		projectKey: project.key, sourceKey: source.key, targetKey: target.targetKey, sourceKind: 'bsl', sourceVersion: '',
		message: id, location: { uri: target.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } } });
	const ticket = async (sequence = 1, ruleId = 'test-a') => store.ticket({ runId: 'run-' + sequence, sequence,
		projectKey: project.key, ruleId, area: 'bsl', category: 'style', severity: 'warning', target,
		settingsRevision: 'r1', sourceVersion: await persistedVersion(target.uri), cancellation: token });
	return { root, dir, project, target, store, issue, ticket, write,
		cleanup: async () => { store.dispose(); await cleanupTestWorkspace(root); } };
}
export type Environment = Awaited<ReturnType<typeof environment>>;
