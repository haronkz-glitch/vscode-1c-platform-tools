import * as vscode from 'vscode';
import * as layout from '../../shared/projectLayout';
import * as identity from '../../features/codeStyle/core/identity';
import * as projectSource from '../../features/codeStyle/sources/projectSource';
import { loadSubject } from './loadSubject';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ensureOwnedUri, sourceRoots, sourceForFile, fileUri, projectForFile } from '../../features/codeStyle/sources/projectSource';
import { safeResolve, targetKeyOf } from '../../features/codeStyle/core/identity';
import { environment, type Environment } from './helpers';
suite('Code Style: проекты', () => {
	let e: Environment;
	setup(async () => { e = await environment(); });
	teardown(async () => { await e.cleanup(); });
	test('0018: незавершённый snapshot дополняется известными проектами и кандидатами', async () => {
		let requests = 0;
		const known = { root: e.root, configuration: e.project.layout.configuration };
		const subject = await loadSubject<typeof projectSource>('sources/projectSource.ts', {
			'node:fs/promises': fs, 'node:path': path, vscode,
			'../../../shared/projectLayout': { ...layout, resolveProjectLayout: async () => e.project.layout },
			'../../../shared/workspaceProjects': {
				projectsSnapshot: () => ({ complete: false, projects: [], candidates: [] }),
				listProjects: async () => { requests++; return []; }, listCandidates: async () => { requests++; return [known]; },
				projectRootKey: identity.projectKeyOf,
			}, '../core/identity': identity,
		});
		const project = await subject.projectByExplicitRoot(e.root);
		assert.ok(project?.candidate);
		assert.strictEqual(requests, 2);
		assert.strictEqual(await subject.projectByExplicitRoot(e.root + '-unknown'), undefined);
		await assert.rejects(() => fs.stat(path.join(e.root, 'packagedef')));
	});
	test('0019: Граница вложенного проекта', async () => {
		const nested = path.join(e.dir, 'nested');
		await fs.mkdir(nested);
		const file = path.join(nested, 'Module.bsl');
		await fs.writeFile(file, '');
		const project = { ...e.project, excludedRoots: [nested] };
		assert.strictEqual(sourceForFile(project, file), undefined);
		await assert.rejects(() => ensureOwnedUri(project, fileUri(file)));
		assert.ok(sourceForFile(project, path.join(e.dir, 'CommonModules/Test/Ext/Module.bsl')));
	});
	test('0020: Идентичность источников и формат EDT', () => {
		const configuration = e.project.layout.configuration!;
		const project = { ...e.project, layout: { ...e.project.layout,
				extensions: [{ ...configuration, dir: path.join(e.root, 'extension'), isExtension: true }],
				others: [{ ...configuration, dir: path.join(e.root, 'edt'), format: 'edt' as const }],
				processors: [{ dir: path.join(e.root, 'processor'), format: 'designer' as const, kind: 'processor' as const, name: 'Test', file: 'Test' }] } };
		const sources = sourceRoots(project);
		assert.strictEqual(sources.length, 4);
		assert.strictEqual(new Set(sources.map(s => s.key)).size, 4);
		assert.strictEqual(new Set(sources.map(s => targetKeyOf(s, 'bsl', path.join(s.root, 'Module.bsl')))).size, 4);
		assert.strictEqual(sources.find(s => s.format === 'edt')?.entry, path.join(e.root, 'edt', 'src', 'Configuration', 'Configuration.mdo'));
	});
	test('0021: Запрет выхода за границы проекта', async () => {
		assert.strictEqual(await projectForFile('untitled:test'), undefined);
		await assert.rejects(() => ensureOwnedUri(e.project, 'https://example.com/test'));
		assert.throws(() => safeResolve(e.dir, '../outside'));
		await assert.rejects(() => ensureOwnedUri(e.project, fileUri(e.dir + '-neighbor/Module.bsl')));
		const outside = path.join(e.root, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'Module.bsl'), '');
		const link = path.join(e.dir, 'link');
		try {
			await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
		}
		catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
				return;
			}
			throw error;
		}
		await assert.rejects(() => ensureOwnedUri(e.project, fileUri(path.join(link, 'Module.bsl'))));
	});
});
