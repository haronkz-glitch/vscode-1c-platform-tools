import * as assert from 'node:assert';
import { ActionRegistry } from '../../features/codeStyle/actions/registry';
import { ActionDispatcher } from '../../features/codeStyle/actions/dispatcher';
import type { ActionContext, ActionDefinition, JsonValue } from '../../features/codeStyle/actions/types';
suite('Code Style: действия', () => {
	const context: ActionContext = { listRules: () => [], getSettings: () => undefined,
		getIssues: () => ({ issues: [], scans: [], pairStates: [], errors: [], complete: true }),
		check: async () => { throw new Error('Тестовые данные'); } };
	const action = (patch: Partial<ActionDefinition> = {}): ActionDefinition => ({ id: 'test.read', title: 'Тестовые данные', description: 'Тестовые данные',
		effect: 'read', validate: x => x, handle: (ctx, input) => ({ success: true, incomplete: false, data: { rules: ctx.listRules().length, input } }), ...patch });
	test('0015: Валидация действий', () => {
		const r = new ActionRegistry();
		const a = action();
		r.register(a);
		assert.throws(() => r.register(action()));
		assert.throws(() => r.register(action({ id: 'invalid', title: '' })));
		assert.strictEqual(r.get(a.id), a);
		assert.deepStrictEqual(r.list(), [a]);
	});
	test('0016: Неизвестное действие', async () => {
		const result = await new ActionDispatcher(new ActionRegistry(), context).dispatch('missing', {});
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.error?.code, 'unknownAction');
	});
	test('0017: JSON, исключения и разрешённые эффекты', async () => {
		const r = new ActionRegistry();
		r.register(action());
		const d = new ActionDispatcher(r, context);
		assert.deepStrictEqual((await d.dispatch('test.read', { value: 1 })).data, { rules: 0, input: { value: 1 } });
		assert.strictEqual((await d.dispatch('test.read', { bad: undefined } as unknown as JsonValue)).error?.code, 'actionFailed');
		r.register(action({ id: 'test.throw', validate: () => { throw new Error('Тестовые данные'); } }));
		r.register(action({ id: 'test.handle', handle: () => { throw new Error('Тестовые данные'); } }));
		for (const id of ['test.throw', 'test.handle']) {
			const result = await d.dispatch(id, null);
			assert.strictEqual(result.success, false);
			assert.ok(!('stack' in result.error!));
		}
		for (const effect of ['sourceWrite', 'settingsWrite'] as const) {
			r.register(action({ id: 'test.' + effect, effect, handle: () => { assert.fail('Тестовые данные'); } }));
			assert.strictEqual((await d.dispatch('test.' + effect, null)).error?.code, 'forbidden');
		}
	});
});
