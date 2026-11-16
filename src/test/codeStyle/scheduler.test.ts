import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { ScanPlanner } from '../../features/codeStyle/core/scanPlanner';
import { ScanScheduler } from '../../features/codeStyle/core/scheduler';
import { RuleRegistry } from '../../features/codeStyle/core/ruleRegistry';
import { SourceRegistry } from '../../features/codeStyle/sources/sourceRegistry';
import { SettingsProvider } from '../../features/codeStyle/core/settings';
import { CodeStyleEngine } from '../../features/codeStyle/core/engine';
import type { ScanResult, ScanScope } from '../../features/codeStyle/core/types';
import { environment, type Environment, rule, deferred } from './helpers';
suite('Code Style: очередь', () => {
	let e: Environment;
	let scheduler: ScanScheduler;
	let rules: RuleRegistry;
	let calls: {
		scope: ScanScope;
		token: vscode.CancellationToken;
		finish: (result: ScanResult) => void;
	}[];
	const result = (scope: ScanScope): ScanResult => ({ requested: scope, runId: 'test', projectKey: scope.projectRoot,
		actualTargets: [], pairs: [], complete: true, status: 'completed', issues: 0, errors: [] });
	setup(async () => {
		e = await environment();
		rules = new RuleRegistry();
		rules.register(rule());
		calls = [];
		class ControlledPlanner extends ScanPlanner {
			override scan(scope: ScanScope, _runId: string, _sequence: number, cancellation: vscode.CancellationToken): Promise<ScanResult> {
				const pending = deferred<ScanResult>();
				calls.push({ scope, token: cancellation, finish: pending.resolve });
				return pending.promise;
			}
		}
		const planner = new ControlledPlanner(rules, new SourceRegistry(), new SettingsProvider(rules), new CodeStyleEngine(), e.store);
		scheduler = new ScanScheduler(planner, rules, e.store);
	});
	teardown(async () => {
		scheduler.dispose();
		for (const call of calls) {
			call.finish(result(call.scope));
		}
		await e.cleanup();
	});
	test('0046: Пустой реестр не запускает Planner', async () => {
		const empty = new RuleRegistry();
		const planner = new ScanPlanner(empty, new SourceRegistry(), new SettingsProvider(empty), new CodeStyleEngine(), e.store);
		planner.scan = async () => assert.fail('Тестовые данные');
		const queue = new ScanScheduler(planner, empty, e.store);
		try {
			assert.strictEqual((await queue.run({ projectRoot: e.root, mode: 'full' })).status, 'noApplicableRules');
		}
		finally {
			queue.dispose();
		}
	});
	test('0047: Объединение событий debounce', async () => {
		const originalSet = globalThis.setTimeout;
		const originalClear = globalThis.clearTimeout;
		const callbacks = new Map<number, () => void>();
		let next = 0;
		globalThis.setTimeout = ((callback: () => void) => { callbacks.set(++next, callback); return next; }) as unknown as typeof setTimeout;
		globalThis.clearTimeout = ((id: number) => { callbacks.delete(id); }) as unknown as typeof clearTimeout;
		try {
			scheduler.schedule(e.root, e.target.uri);
			scheduler.schedule(e.root, e.target.uri);
			scheduler.schedule(e.root, e.target.uri + '-next');
			assert.strictEqual(callbacks.size, 1);
			[...callbacks.values()][0]();
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].scope.files, [e.target.uri, e.target.uri + '-next']);
			calls[0].finish(result(calls[0].scope));
			await Promise.resolve();
		}
		finally {
			globalThis.setTimeout = originalSet;
			globalThis.clearTimeout = originalClear;
		}
	});
	test('0048: Независимый прогресс проектов и ограничение очереди', async () => {
		const a = scheduler.run({ projectRoot: e.root, mode: 'full' });
		const b = scheduler.run({ projectRoot: e.root + '-b', mode: 'full' });
		const c = scheduler.run({ projectRoot: e.root + '-c', mode: 'full' });
		assert.strictEqual(calls.length, 2);
		calls[0].finish(result(calls[0].scope));
		await a;
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(calls.length, 3);
		calls[1].finish(result(calls[1].scope));
		calls[2].finish(result(calls[2].scope));
		await Promise.all([b, c]);
	});
	test('0049: Чужой файл не отменяет независимую проверку', async () => {
		const pending = scheduler.run({ projectRoot: e.root, mode: 'partial', files: [e.target.uri] });
		scheduler.cancelForFile(e.target.uri + '-other');
		assert.strictEqual(calls[0].token.isCancellationRequested, false);
		calls[0].finish(result(calls[0].scope));
		assert.strictEqual((await pending).status, 'completed');
	});
	test('0051: Отмена, dispose и поздний результат', async () => {
		let publications = 0;
		const subscription = scheduler.onDidChangeScanState(() => publications++);
		const active = scheduler.run({ projectRoot: e.root, mode: 'partial', files: [e.target.uri] });
		const waiting = scheduler.run({ projectRoot: e.root, mode: 'full' });
		scheduler.cancelProject(e.project.key);
		assert.strictEqual((await waiting).status, 'cancelled');
		assert.ok(calls[0].token.isCancellationRequested);
		scheduler.dispose();
		const before = publications;
		calls[0].finish(result(calls[0].scope));
		await active;
		assert.strictEqual(publications, before);
		assert.strictEqual((await scheduler.run({ projectRoot: e.root, mode: 'full' })).status, 'cancelled');
		subscription.dispose();
	});
});
