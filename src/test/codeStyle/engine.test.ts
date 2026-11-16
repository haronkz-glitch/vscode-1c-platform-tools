import { canonicalFileUri } from '../../features/codeStyle/core/identity';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CodeStyleEngine } from '../../features/codeStyle/core/engine';
import { BslSourceProvider } from '../../features/codeStyle/sources/bslSource';
import { fileUri } from '../../features/codeStyle/sources/projectSource';
import type { RuleDefinition, RuleIssue, SourceProvider } from '../../features/codeStyle/core/types';
import { environment, type Environment, rule, effective, token, deferred } from './helpers';
suite('Code Style: движок', () => {
	let e: Environment;
	setup(async () => { e = await environment(); });
	teardown(async () => { await e.cleanup(); });
	const run = (rules: RuleDefinition[], provider: SourceProvider = new BslSourceProvider(), cancellation = token) => new CodeStyleEngine().checkTarget(e.project, e.target, provider, rules, Object.fromEntries(rules.map(r => [r.id, effective])), cancellation, () => 0);
	test('0031: Предварительный отбор без чтения', async () => {
		let reads = 0;
		const provider = new BslSourceProvider();
		const result = await run([rule('test-b'), rule('test-a'), rule('test-c', { supportsTarget: () => false, check: () => assert.fail('Тестовые данные') })], { ...provider, kind: 'bsl', enumerate: provider.enumerate.bind(provider), read: async () => { reads++; throw new Error('Тестовые данные'); } });
		assert.deepStrictEqual(result.pairs.map(p => [p.ruleId, p.status]), [['test-c', 'skipped'], ['test-a', 'completed'], ['test-b', 'completed']]);
		assert.strictEqual(reads, 0);
	});
	test('0032: Разделяемое чтение и изоляция ошибки', async () => {
		for (const fail of [false, true]) {
			let reads = 0;
			const original = new BslSourceProvider();
			const provider: SourceProvider = { kind: 'bsl', enumerate: original.enumerate.bind(original), read: async (...args) => {
					reads++;
					if (fail) {
						throw new Error('Тестовые данные');
					}
					return original.read(...args);
				} };
			const detail = async (ctx: Parameters<RuleDefinition['check']>[0]) => { await ctx.read(); return []; };
			const result = await run([rule('test-a', { check: detail }), rule('test-b', { check: detail }), rule('test-c')], provider);
			assert.strictEqual(reads, 1);
			assert.deepStrictEqual(result.pairs.map(p => p.status), fail ? ['error', 'error', 'completed'] : ['completed', 'completed', 'completed']);
			assert.ok(result.pairs.every(p => p.issues.length === 0));
		}
	});
	test('0033: Синхронные результаты и исключения', async () => {
		const result = await run([rule('test-a'), rule('test-b', { check: async () => [] }), rule('test-c', { check: () => { throw new Error('Тестовые данные'); } })]);
		assert.deepStrictEqual(result.pairs.map(p => p.status), ['completed', 'completed', 'error']);
		assert.strictEqual(result.pairs[2].error?.code, 'ruleCheckFailed');
		assert.deepStrictEqual(result.pairs[2].issues, []);
	});
	test('0034: Нормализация и стабильные идентификаторы', async () => {
		const issue = e.issue();
		const r = rule('test-a', { area: 'metadata', category: 'security', check: () => [issue, issue] });
		const first = (await run([r])).pairs[0].issues;
		const second = (await run([r])).pairs[0].issues;
		assert.strictEqual(first.length, 2);
		assert.notStrictEqual(first[0].id, first[1].id);
		assert.deepStrictEqual(first, second);
		assert.strictEqual(first[0].area, 'metadata');
		assert.strictEqual(first[0].category, 'security');
		assert.strictEqual(first[0].severity, 'warning');
		assert.strictEqual(first[0].ruleId, r.id);
		assert.deepStrictEqual(first[0].location, { ...issue.location, uri: canonicalFileUri(issue.location.uri) });
		assert.ok(first[0].sourceVersion);
	});
	test('0035: Некорректные результаты отклоняются целиком', async () => {
		const good = e.issue();
		const invalid: unknown[] = [null, [good, { ...good, location: { ...good.location, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } } }],
			[good, { ...good, location: { ...good.location, uri: fileUri(e.root + '-outside/Module.bsl') } }],
			[good, { ...good, fix: { kind: 'write' } }]];
		for (const answer of invalid) {
			const result = await run([rule('test-a', { check: () => answer as RuleIssue[] }), rule('test-b')]);
			assert.strictEqual(result.pairs[0].status, 'error');
			assert.deepStrictEqual(result.pairs[0].issues, []);
			assert.strictEqual(result.pairs[1].status, 'completed');
		}
	});
	test('0036: Связанные файлы и отмена', async () => {
		const uri = fileUri(await e.write('Related.bsl', 'Тестовые данные'));
		const result = await run([rule('test-a', { check: async (ctx) => { assert.strictEqual((await ctx.readRelated(uri)).text, 'Тестовые данные'); return []; } })]);
		assert.strictEqual(result.pairs[0].dependencies[0].uri, canonicalFileUri(uri));
		assert.ok(result.pairs[0].dependencies[0].version);
		assert.strictEqual((await run([rule('test-a', { check: async (ctx) => { await ctx.readRelated(fileUri(e.root + '-outside/file')); return []; } })])).pairs[0].status, 'error');
		const started = deferred<void>();
		const finish = deferred<void>();
		const source = new vscode.CancellationTokenSource();
		try {
			const pending = run([rule('test-a', { check: async () => { started.resolve(); await finish.promise; return [e.issue()]; } })], undefined, source.token);
			await started.promise;
			source.cancel();
			finish.resolve();
			assert.strictEqual((await pending).pairs[0].status, 'cancelled');
		}
		finally {
			source.dispose();
		}
	});
});
