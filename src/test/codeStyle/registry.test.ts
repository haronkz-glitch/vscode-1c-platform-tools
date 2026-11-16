import * as assert from 'node:assert';
import { RuleRegistry } from '../../features/codeStyle/core/ruleRegistry';
import { SourceRegistry } from '../../features/codeStyle/sources/sourceRegistry';
import { SettingsProvider } from '../../features/codeStyle/core/settings';
import { BslSourceProvider } from '../../features/codeStyle/sources/bslSource';
import { rule } from './helpers';
import type { RuleDefinition } from '../../features/codeStyle/core/types';
suite('Code Style: реестры', () => {
	test('0011: Регистрация и стабильный порядок', () => {
		const r = new RuleRegistry();
		const a = rule('test-a', { area: 'metadata', category: 'security', sourceKinds: ['bsl', 'metadata'] });
		r.register(rule('test-b'));
		r.register(a);
		assert.strictEqual(r.get(a.id), a);
		assert.deepStrictEqual(r.list().map(x => x.id), ['test-a', 'test-b']);
		assert.deepStrictEqual(r.list(), r.list());
	});
	test('0012: Невалидные определения и дубликаты', () => {
		const r = new RuleRegistry();
		const a = rule();
		r.register(a);
		assert.throws(() => r.register(rule()));
		for (const patch of [{ category: 'invalid' }, { title: '' }, { check: null }, { sourceKinds: [] }]) {
			assert.throws(() => r.register({ ...rule('invalid'), ...patch } as unknown as RuleDefinition));
		}
		assert.strictEqual(r.get(a.id), a);
		assert.strictEqual(r.list().length, 1);
	});
	test('0013: Совместное применение фильтров', () => {
		const r = new RuleRegistry();
		r.register(rule());
		r.register(rule('test-b', { defaultEnabled: false }));
		const settings = new SettingsProvider(r).read(process.cwd());
		assert.deepStrictEqual(r.select(settings, { ruleIds: ['test-a'], areas: ['bsl'], categories: ['style'], kinds: ['bsl'] }).map(x => x.id), ['test-a']);
		assert.deepStrictEqual(r.select(settings, { kinds: ['metadata'] }), []);
		assert.deepStrictEqual(r.select({ ...settings, enabled: false }), []);
	});
	test('0014: Регистрация поставщиков', () => {
		const r = new SourceRegistry();
		const bsl = new BslSourceProvider();
		r.register(bsl);
		r.register({ kind: 'metadata', enumerate: async () => ({ targets: [], complete: true, revision: '', errors: [] }), read: async () => { throw new Error('Тестовые данные'); } });
		assert.throws(() => r.register(bsl));
		assert.strictEqual(r.get('bsl'), bsl);
		for (const kind of ['form', 'query', 'rights'] as const) {
			assert.strictEqual(r.get(kind), undefined);
		}
	});
});
