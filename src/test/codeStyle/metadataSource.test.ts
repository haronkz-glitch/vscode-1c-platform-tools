import { loadSubject } from './loadSubject';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as layout from '../../shared/projectLayout';
import * as identity from '../../features/codeStyle/core/identity';
import * as versions from '../../features/codeStyle/core/sourceVersion';
import * as projects from '../../features/codeStyle/sources/projectSource';
import * as schema from '../../features/metadata/mdSparrowSchemaVersion';
import { MetadataSourceProvider } from '../../features/codeStyle/sources/metadataSource';
import { CodeStyleEngine } from '../../features/codeStyle/core/engine';
import { fixturePath } from '../fixtures/helpers/fixturePath';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';
import { environment, type Environment, rule, effective, token, deferred } from './helpers';
import type { ProjectMetadataTreeDto } from '../../features/metadata/metadataTreeService';
// Load the unchanged provider with doubles only at the external tree/runtime boundary.
async function isolatedProvider(e: Environment) {
	const tree: ProjectMetadataTreeDto = JSON.parse(await fs.readFile(fixturePath('codeStyle', 'tree.json'), 'utf8'));
	let runtimeCalls = 0;
	const calls: {
		params: Record<string, unknown>;
		options: {
			cwd: string;
			token: vscode.CancellationToken;
		};
	}[] = [];
	let load = async () => tree;
	const dto = await fs.readFile(fixturePath('codeStyle', 'dto.json'), 'utf8');
	let read = async () => ({ exitCode: 0, stdout: dto, stderr: '' });
	const dependencies: Record<string, unknown> = {
		'node:path': path, vscode, '../../../shared/projectLayout': layout,
		'../../metadata/metadataTreeService': { loadProjectMetadataTree: () => load() },
		'../../metadata/mdSparrowBootstrap': { ensureMdSparrowRuntime: async () => { runtimeCalls++; return {}; } },
		'../../metadata/mdSparrowParams': { runMdSparrowParamsRead: async (_runtime: unknown, params: Record<string, unknown>, options: {
				cwd: string;
				token: vscode.CancellationToken;
			}) => { calls.push({ params, options }); return read(); } },
		'../core/sourceVersion': versions, '../../metadata/mdSparrowSchemaVersion': schema,
		'../core/identity': identity, './projectSource': projects,
	};
	const exports = await loadSubject<{
		MetadataSourceProvider: typeof MetadataSourceProvider;
	}>('sources/metadataSource.ts', dependencies);
	const provider = new exports.MetadataSourceProvider!(createMockExtensionContext(e.root));
	return { provider, tree, calls, runtimeCalls: () => runtimeCalls, setLoad: (fn: typeof load) => { load = fn; }, setRead: (fn: typeof read) => { read = fn; } };
}
suite('Code Style: метаданные', () => {
	let e: Environment;
	let h: Awaited<ReturnType<typeof isolatedProvider>>;
	setup(async () => { e = await environment(); h = await isolatedProvider(e); await e.write('CommonModules/Test.xml', '<object/>'); });
	teardown(async () => { await e.cleanup(); });
	test('0026: descriptors сохраняют реальные пути, отсутствующая цель не синтезируется', async () => {
		const result = await h.provider.enumerate(e.project, {}, token);
		assert.ok(result.complete);
		assert.strictEqual(result.targets.length, 2);
		assert.ok(result.targets.some(t => t.isSourceRoot));
		assert.ok(result.targets.every(t => t.sourceKey === e.target.sourceKey));
		const extensionDir = path.join(e.root, 'extension');
		const edtDir = path.join(e.root, 'edt');
		await fs.mkdir(extensionDir);
		await fs.writeFile(path.join(extensionDir, 'Configuration.xml'), '<configuration/>');
		await fs.mkdir(path.join(edtDir, 'src', 'Configuration'), { recursive: true });
		await fs.writeFile(path.join(edtDir, 'src', 'Configuration', 'Configuration.mdo'), '<configuration/>');
		await fs.mkdir(path.join(edtDir, 'src', 'CommonModules', 'Test'), { recursive: true });
		await fs.writeFile(path.join(edtDir, 'src', 'CommonModules', 'Test', 'Test.mdo'), '<object/>');
		const original = h.tree.sources[0];
		h.tree.sources.push({ ...original, id: 'extension', kind: 'extension', configurationXmlRelativePath: 'extension/Configuration.xml', metadataRootRelativePath: 'extension', groups: [] }, { ...original, id: 'edt', configurationXmlRelativePath: 'edt/src/Configuration/Configuration.mdo', metadataRootRelativePath: 'edt/src', groups: [{ ...original.groups[0], items: [{ ...original.groups[0].items[0], relativePath: 'edt/src/CommonModules/Test/Test.mdo' }] }] });
		const project = { ...e.project, layout: { ...e.project.layout,
				extensions: [{ dir: extensionDir, format: 'designer' as const, name: 'Test', isExtension: true }],
				others: [{ dir: edtDir, format: 'edt' as const, name: 'Test', isExtension: false }] } };
		const mixed = await h.provider.enumerate(project, {}, token);
		assert.ok(mixed.complete);
		assert.strictEqual(mixed.targets.length, 5);
		assert.ok(mixed.targets.some(t => t.format === 'edt' && t.uri.endsWith('.mdo')));
		h.tree.sources.splice(1);
		await fs.unlink(path.join(e.dir, 'CommonModules/Test.xml'));
		const missing = await h.provider.enumerate(e.project, {}, token);
		assert.strictEqual(missing.complete, false);
		assert.strictEqual(missing.targets.length, 1);
		assert.ok(missing.errors.length);
	});
	test('0027: supportsTarget и descriptor-only правило не запускают runtime', async () => {
		const target = (await h.provider.enumerate(e.project, {}, token)).targets[0];
		const rules = [rule('test-a', { sourceKinds: ['metadata'], supportsTarget: () => false, check: () => assert.fail('Неподходящее правило вызвано') }), rule('test-b', { sourceKinds: ['metadata'] })];
		const result = await new CodeStyleEngine().checkTarget(e.project, target, h.provider, rules, { 'test-a': effective, 'test-b': effective }, token, () => 0);
		assert.deepStrictEqual(result.pairs.map(p => p.status), ['skipped', 'completed']);
		assert.strictEqual(h.runtimeCalls(), 0);
		assert.deepStrictEqual(h.calls, []);
	});
	test('0028: корень и объект используют только read-only операции с путями и отменой', async () => {
		const targets = (await h.provider.enumerate(e.project, {}, token)).targets;
		for (const target of targets) {
			await h.provider.read(e.project, target, token);
		}
		assert.deepStrictEqual(h.calls.map(c => c.params.op).sort(), ['cf-configuration-properties-get', 'cf-md-object-get']);
		for (const call of h.calls) {
			assert.strictEqual(call.options.cwd, e.root);
			assert.strictEqual(call.options.token, token);
			assert.ok(call.params.schemaVersion);
		}
		assert.ok(h.calls.some(c => typeof c.params.objectXml === 'string' && identity.keyOfPath(c.params.objectXml) === identity.keyOfPath(path.join(e.dir, 'CommonModules/Test.xml'))));
		assert.ok(h.calls.some(c => typeof c.params.configurationXml === 'string' && identity.keyOfPath(c.params.configurationXml) === identity.keyOfPath(path.join(e.dir, 'Configuration.xml'))));
	});
	test('0029: DTO commonModule не переносится в scalars', async () => {
		const target = (await h.provider.enumerate(e.project, {}, token)).targets[0];
		const snapshot = await h.provider.read(e.project, target, token);
		assert.deepStrictEqual(snapshot.dto, JSON.parse(await fs.readFile(fixturePath('codeStyle', 'dto.json'), 'utf8')));
		assert.ok(snapshot.version);
	});
	test('0030: ошибки дерева, unsupported и поздняя отмена не становятся пустым успехом', async () => {
		await e.write('Test.xml', '<external/>');
		const externalProject = { ...e.project, layout: { ...e.project.layout, configuration: undefined,
				processors: [{ dir: e.dir, format: 'designer' as const, kind: 'processor' as const, name: 'Test', file: 'Test' }] } };
		const external = await h.provider.enumerate(externalProject, {}, token);
		assert.ok(external.complete);
		assert.strictEqual(external.targets[0].objectType, 'ExternalDataProcessor');
		assert.strictEqual(h.runtimeCalls(), 0);
		h.setLoad(async () => { throw new Error('Ошибка JVM'); });
		const failed = await h.provider.enumerate(e.project, {}, token);
		assert.strictEqual(failed.complete, false);
		assert.ok(failed.errors.length);
		h.setLoad(async () => h.tree);
		h.tree.sources[0] = { ...h.tree.sources[0], schemaSupported: false };
		const unsupported = await h.provider.enumerate(e.project, {}, token);
		assert.strictEqual(unsupported.complete, false);
		assert.ok(unsupported.errors.some(x => x.code === 'metadataSchemaUnsupported'));
		h.tree.sources[0] = { ...h.tree.sources[0], schemaSupported: true };
		const target = (await h.provider.enumerate(e.project, {}, token)).targets[0];
		const started = deferred<void>();
		const finish = deferred<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>();
		h.setRead(() => { started.resolve(); return finish.promise; });
		const source = new vscode.CancellationTokenSource();
		try {
			const pending = h.provider.read(e.project, target, source.token);
			await started.promise;
			source.cancel();
			finish.resolve({ exitCode: 0, stdout: '{}', stderr: '' });
			await assert.rejects(pending, (error: unknown) => error instanceof versions.SourceDataError && error.code === 'cancelled');
		}
		finally {
			source.dispose();
		}
	});
});
