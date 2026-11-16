import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { loadSubject } from './loadSubject';
import { environment, type Environment, rule, token, deferred } from './helpers';
import { ScanPlanner } from '../../features/codeStyle/core/scanPlanner';
import { RuleRegistry } from '../../features/codeStyle/core/ruleRegistry';
import { SourceRegistry } from '../../features/codeStyle/sources/sourceRegistry';
import { SettingsProvider } from '../../features/codeStyle/core/settings';
import { CodeStyleEngine } from '../../features/codeStyle/core/engine';
import { IssueStore } from '../../features/codeStyle/core/issueStore';
import * as identity from '../../features/codeStyle/core/identity';
import * as projects from '../../features/codeStyle/sources/projectSource';
import { logger } from '../../shared/logger';
import { BslSourceProvider } from '../../features/codeStyle/sources/bslSource';
suite('Code Style: Planner', () => {
	let e: Environment;
	let rules: RuleRegistry;
	let sources: SourceRegistry;
	let planner: ScanPlanner;
	setup(async () => {
		e = await environment();
		rules = new RuleRegistry();
		rules.register(rule());
		rules.register(rule('test-b'));
		sources = new SourceRegistry();
		sources.register(new BslSourceProvider());
		const subject = await loadSubject<{
			ScanPlanner: typeof ScanPlanner;
		}>('core/scanPlanner.ts', {
			vscode, '../../../shared/logger': { logger }, './identity': identity,
			'../sources/projectSource': { ...projects, projectByExplicitRoot: async (root: string) => root === e.root ? e.project : undefined },
			'../sources/sourceRegistry': { SourceRegistry }, './ruleRegistry': { RuleRegistry }, './settings': { SettingsProvider },
			'./engine': { CodeStyleEngine }, './issueStore': { IssueStore },
		});
		planner = new subject.ScanPlanner(rules, sources, new SettingsProvider(rules), new CodeStyleEngine(), e.store);
	});
	teardown(async () => { await e.cleanup(); });
	test('0045: full и partial по файлу, цели и паре сохраняют запрошенную область', async () => {
		const base = { projectRoot: e.root };
		const scopes = [{ ...base, mode: 'full' as const }, { ...base, mode: 'partial' as const, files: [e.target.uri] },
			{ ...base, mode: 'partial' as const, targetKeys: [e.target.targetKey] },
			{ ...base, mode: 'partial' as const, pairs: [{ ruleId: 'test-a', targetKey: e.target.targetKey }] }];
		for (const [index, scope] of scopes.entries()) {
			const result = await planner.scan(scope, 'test-' + index, index + 1, token);
			assert.strictEqual(result.status, 'completed');
			assert.deepStrictEqual(result.actualTargets, [e.target.targetKey]);
			assert.strictEqual(result.pairs.length, index === 3 ? 1 : 2);
			assert.deepStrictEqual(result.requested, scope);
		}
		const missing = await planner.scan({ ...base, mode: 'full', ruleIds: ['missing'] }, 'missing', 5, token);
		assert.strictEqual(missing.status, 'noApplicableRules');
	});
	test('0048: Planner ограничивает параллельные цели снимком maxConcurrency', async () => {
		await e.write('Second.bsl');
		await e.write('Third.bsl');
		const gates = new Map<string, ReturnType<typeof deferred<void>>>();
		let nextStarted = deferred<void>();
		const twoStarted = deferred<void>();
		const thirdStarted = deferred<void>();
		let active = 0;
		let maximum = 0;
		const controlledRules = new RuleRegistry();
		controlledRules.register(rule('test-a', { check: async (ctx) => {
				const gate = deferred<void>();
				gates.set(ctx.target.uri, gate);
				nextStarted.resolve();
				active++;
				maximum = Math.max(maximum, active);
				if (gates.size === 2) {
					twoStarted.resolve();
				}
				if (gates.size === 3) {
					thirdStarted.resolve();
				}
				await gate.promise;
				active--;
				return [];
			} }));
		const settings = new SettingsProvider(controlledRules);
		const original = settings.read.bind(settings);
		let concurrency = 2;
		settings.read = root => ({ ...original(root), maxConcurrency: concurrency });
		const controlled = new (planner.constructor as typeof ScanPlanner)(controlledRules, sources, settings, new CodeStyleEngine(), e.store);
		const pending = controlled.scan({ projectRoot: e.root, mode: 'full' }, 'concurrency', 1, token);
		await twoStarted.promise;
		assert.strictEqual(gates.size, 2);
		concurrency = 1;
		[...gates.values()][0].resolve();
		await thirdStarted.promise;
		for (const gate of gates.values()) {
			gate.resolve();
		}
		assert.strictEqual((await pending).status, 'completed');
		assert.strictEqual(maximum, 2);
		gates.clear();
		maximum = 0;
		nextStarted = deferred<void>();
		const nextRun = controlled.scan({ projectRoot: e.root, mode: 'full' }, 'concurrency-one', 2, token);
		for (let count = 1; count <= 3; count++) {
			await nextStarted.promise;
			assert.strictEqual(gates.size, count);
			nextStarted = deferred<void>();
			[...gates.values()][count - 1].resolve();
		}
		assert.strictEqual((await nextRun).status, 'completed');
		assert.strictEqual(maximum, 1);
	});
	test('0050: ошибка одного поставщика сохраняет успешные пары и непосещённые замечания', async () => {
		rules.register(rule('test-metadata', { area: 'metadata', sourceKinds: ['metadata'] }));
		sources.register({ kind: 'metadata', enumerate: async () => ({ targets: [], complete: false, revision: '', errors: [{ code: 'runtime', message: 'Ошибка внешнего источника' }] }), read: async () => assert.fail('Нет целей') });
		const result = await planner.scan({ projectRoot: e.root, mode: 'full' }, 'partial', 1, token);
		assert.strictEqual(result.complete, false);
		assert.ok(['partial', 'error', 'unsupported'].includes(result.status));
		assert.ok(result.pairs.filter(p => p.status === 'completed').length >= 2);
		assert.ok(result.errors.some(error => error.code === 'runtime'));
	});
});
