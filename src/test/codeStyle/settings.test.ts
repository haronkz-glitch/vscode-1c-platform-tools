import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { SettingsProvider } from '../../features/codeStyle/core/settings';
import { RuleRegistry } from '../../features/codeStyle/core/ruleRegistry';
import { environment, type Environment, rule } from './helpers';
suite('Code Style: настройки', () => {
	let e: Environment;
	let restore: typeof vscode.workspace.getConfiguration;
	let values: Record<string, unknown>;
	let settings: SettingsProvider;
	setup(async () => {
		e = await environment();
		values = {};
		restore = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = ((section: string, scope?: vscode.ConfigurationScope | null) => {
			if (section !== '1c-platform-tools') {
				return restore(section, scope);
			}
			return { get: (key: string, fallback: unknown) => values[key] ?? fallback } as vscode.WorkspaceConfiguration;
		}) as typeof restore;
		const rules = new RuleRegistry();
		rules.register(rule('test-a', { options: { limit: { type: 'number', default: 2, min: 1, max: 8 } } }));
		rules.register(rule('test-b', { defaultEnabled: false }));
		settings = new SettingsProvider(rules);
	});
	teardown(async () => { vscode.workspace.getConfiguration = restore; await e.cleanup(); });
	test('0052: Настройки читаются с URI проекта', () => {
		const scopes: string[] = [];
		const original = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = ((section: string, scope?: vscode.ConfigurationScope | null) => {
			scopes.push((scope as vscode.Uri).fsPath);
			return original(section, scope);
		}) as typeof original;
		const first = settings.read(e.root);
		const second = settings.read(e.dir);
		assert.notStrictEqual(first.projectKey, second.projectKey);
		assert.deepStrictEqual(scopes, [e.root, e.dir].map(root => vscode.Uri.file(root).fsPath));
	});
	test('0053: Приоритет категории над правилом', () => {
		assert.strictEqual(settings.read(e.root).rules['test-b'].enabled, false);
		values['codeStyle.categories'] = { style: false };
		values['codeStyle.rules'] = { 'test-a': { enabled: true }, unknown: { enabled: true } };
		const read = settings.read(e.root);
		assert.strictEqual(read.rules['test-a'].enabled, false);
		assert.strictEqual(read.rules.unknown, undefined);
	});
	test('0054: Валидация severity и опций', () => {
		values['codeStyle.rules'] = { 'test-a': { severity: 'error', options: { limit: 5 } } };
		const read = settings.read(e.root).rules['test-a'];
		assert.strictEqual(read.severity, 'error');
		assert.strictEqual(read.options.limit, 5);
		for (const override of [{ severity: 'off' }, { options: { limit: '2' } }, { options: { limit: 9 } }, { options: { unknown: true } }]) {
			values['codeStyle.rules'] = { 'test-a': override };
			assert.throws(() => settings.read(e.root));
			assert.ok(settings.safeRead(e.root).error);
		}
	});
	test('0055: Независимые ревизии и неизменяемый снимок', () => {
		const before = settings.read(e.root);
		values['codeStyle.rules'] = { 'test-a': { severity: 'hint' } };
		const after = settings.read(e.root);
		assert.notStrictEqual(before.rules['test-a'].revision, after.rules['test-a'].revision);
		assert.strictEqual(before.rules['test-b'].revision, after.rules['test-b'].revision);
		assert.strictEqual(before.rules['test-a'].severity, 'warning');
	});
	test('0056: Включение и ограничение concurrency', () => {
		values['codeStyle.scanOnSave'] = false;
		assert.strictEqual(settings.read(e.root).rules['test-a'].enabled, true);
		values['codeStyle.enabled'] = false;
		assert.strictEqual(settings.read(e.root).rules['test-a'].enabled, false);
		for (const value of [0, 9, 1.5, '2']) {
			values['codeStyle.maxConcurrency'] = value;
			assert.throws(() => settings.read(e.root));
		}
	});
});
