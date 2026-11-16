import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { environment, type Environment, deferred } from './helpers';
import { persistedVersion } from '../../features/codeStyle/core/sourceVersion';
import { fileUri } from '../../features/codeStyle/sources/projectSource';
suite('Code Style: хранилище', () => {
	let e: Environment;
	setup(async () => { e = await environment(); });
	teardown(async () => { await e.cleanup(); });
	test('0037: Атомарная замена набора', async () => {
		assert.ok(await e.store.commit(await e.ticket(), [e.issue()]));
		assert.ok(await e.store.commit(await e.ticket(2), [e.issue('two'), e.issue('three')]));
		assert.deepStrictEqual(e.store.getIssues().map(i => i.id).sort(), ['three', 'two']);
		assert.ok(await e.store.commit(await e.ticket(3), []));
		assert.deepStrictEqual(e.store.getIssues(), []);
		assert.strictEqual(e.store.getPairStates()[0].status, 'completed');
	});
	test('0038: Изоляция соседних пар и проектов', async () => {
		const other = await environment();
		try {
			await e.store.commit(await e.ticket(), [e.issue()]);
			await e.store.commit(await e.ticket(2, 'test-b'), [e.issue('neighbor', 'test-b')]);
			e.store.setRuleRevisions(other.project.key, { 'test-a': 'r1' });
			await e.store.commit(await other.ticket(), [other.issue('other')]);
			await e.store.commit(await e.ticket(3), []);
			assert.deepStrictEqual(e.store.getIssues().map(i => i.id).sort(), ['neighbor', 'other']);
			assert.strictEqual(e.store.getPairStates().length, 3);
		}
		finally {
			await other.cleanup();
		}
	});
	test('0039: Инвалидация исходника и зависимости', async () => {
		const uri = fileUri(await e.write('Related.bsl', 'dependency'));
		const ticket = { ...await e.ticket(), dependencies: [{ uri, version: await persistedVersion(uri), generation: 0 }] };
		await e.store.commit(ticket, [e.issue()]);
		await e.store.commit(await e.ticket(2, 'test-b'), [e.issue('neighbor', 'test-b')]);
		assert.strictEqual(e.store.invalidateUri(uri).length, 1);
		assert.deepStrictEqual(e.store.getIssues().map(i => i.id), ['neighbor']);
		assert.strictEqual(e.store.getIssues({ status: 'stale' }).length, 1);
		e.store.invalidateUri(e.target.uri);
		assert.deepStrictEqual(e.store.getIssues(), []);
	});
	test('0040: Технические ошибки сохраняют результат', async () => {
		await e.store.commit(await e.ticket(), [e.issue()]);
		for (const status of ['error', 'cancelled', 'unsupported'] as const) {
			assert.ok(e.store.fail(await e.ticket(2), status, { code: status, message: 'Тестовые данные' }));
			assert.deepStrictEqual(e.store.getIssues().map(i => i.id), ['one']);
			assert.strictEqual(e.store.getPairStates()[0].error?.code, status);
		}
	});
	test('0041: Старый full не перезаписывает новый partial', async () => {
		for (const status of ['completed', 'error', 'cancelled'] as const) {
			const old = await e.ticket(1);
			const gate = deferred<void>();
			const pending = (async () => { await gate.promise; return status === 'completed' ? e.store.commit(old, [e.issue('old')]) : e.store.fail(old, status); })();
			assert.ok(await e.store.commit(await e.ticket(2), [e.issue('new')]));
			gate.resolve();
			assert.strictEqual(await pending, false);
			assert.deepStrictEqual(e.store.getIssues().map(i => i.id), ['new']);
			assert.strictEqual(e.store.getPairStates()[0].stale, false);
		}
	});
	test('0042: Отказ устаревшим tickets', async () => {
		await e.store.commit(await e.ticket(), [e.issue()]);
		let events = 0;
		const subscription = e.store.onDidChange(change => {
			if (change.reason === 'commit') {
				events++;
			}
		});
		const source = new vscode.CancellationTokenSource();
		source.cancel();
		try {
			const base = await e.ticket(2);
			for (const patch of [{ sourceVersion: 'old' }, { settingsRevision: 'old' }, { cancellation: source.token },
				{ dependencies: [{ uri: e.target.uri, version: 'old', generation: 0 }] }]) {
				assert.strictEqual(await e.store.commit({ ...base, ...patch }, []), false);
			}
			assert.strictEqual(events, 0);
			assert.strictEqual(e.store.getIssues().length, 1);
		}
		finally {
			source.dispose();
			subscription.dispose();
		}
	});
	test('0043: Очистка полного обхода ограничена scope', async () => {
		await e.store.commit(await e.ticket(), [e.issue()]);
		await e.store.commit(await e.ticket(2, 'test-b'), [e.issue('neighbor', 'test-b')]);
		const input = { projectKey: e.project.key, inventoryGeneration: 0, projectGeneration: 0, sequence: 3,
			ruleIds: ['test-a'], kinds: ['bsl'] as const, applicablePairs: new Set<string>() };
		e.store.bumpInventory(e.project.key);
		assert.strictEqual(e.store.reconcileFull(input), false);
		assert.strictEqual(e.store.getIssues().length, 2);
		assert.ok(e.store.reconcileFull({ ...input, inventoryGeneration: 1 }));
		assert.deepStrictEqual(e.store.getIssues().map(i => i.id), ['neighbor']);
	});
	test('0044: Фильтры, копии, события и удаление', async () => {
		const changes: string[][] = [];
		const subscription = e.store.onDidChange(change => changes.push([...change.uris]));
		try {
			await e.store.commit(await e.ticket(), [e.issue()]);
			const filter = { projectKey: e.project.key, sourceKey: e.target.sourceKey, targetKey: e.target.targetKey,
				uri: e.target.uri, ruleId: 'test-a', area: 'bsl' as const, category: 'style' as const, severity: 'warning' as const, status: 'current' as const };
			const found = e.store.getIssues(filter);
			assert.strictEqual(found.length, 1);
			Object.assign(found[0].location.range.start, { line: 99 });
			assert.strictEqual(e.store.getIssues()[0].location.range.start.line, 0);
			assert.deepStrictEqual(e.store.getIssues({ ...filter, severity: 'error' }), []);
			e.store.removeUri(e.target.uri);
			assert.deepStrictEqual(e.store.getIssues({ status: 'all' }), []);
			assert.ok(changes.every(uris => uris.every(uri => uri === e.target.uri)));
			await e.store.commit(await e.ticket(2), [e.issue()]);
			e.store.removeProject(e.project.key);
			assert.deepStrictEqual(e.store.getPairStates(), []);
		}
		finally {
			subscription.dispose();
		}
	});
});
