import { logger } from '../../../shared/logger';
import type { ActionContext, ActionEffect, ActionResult, JsonValue } from './types';
import { ActionRegistry } from './registry';

const log = logger.scope('code-style');
/** A writable effect is a declaration, not permission. Task 1 never authorizes source writes. */
export class ActionDispatcher {
	constructor(
		private readonly registry: ActionRegistry,
		private readonly context: ActionContext,
		private readonly mayExecute: (effect: ActionEffect) => boolean = (effect) => effect === 'read'
	) {}
	async dispatch(id: string, input: JsonValue): Promise<ActionResult> {
		const action = this.registry.get(id);
		if (!action) {
			return { success: false, incomplete: false,
				error: { code: 'unknownAction', message: `Действие не зарегистрировано: ${id}` } };
		}
		if (!this.mayExecute(action.effect)) {
			return { success: false, incomplete: false, error: { code: 'forbidden', message: 'Действие требует отдельного разрешения.' } };
		}
		try {
			const validated = action.validate(input);
			if (validated === undefined || JSON.stringify(validated) === undefined) {
				throw new Error('Параметры должны быть JSON-совместимыми.');
			}
			const answer = await action.handle(this.context, validated);
			if (!answer || typeof answer.success !== 'boolean' || typeof answer.incomplete !== 'boolean') {
				throw new Error('Некорректный ответ действия.');
			}
			return answer;
		} catch (error) {
			log.error(`Действие ${id}: ${error instanceof Error ? error.stack ?? error.message : error}`);
			return { success: false, incomplete: false,
				error: { code: 'actionFailed', message: error instanceof Error ? error.message : String(error) } };
		}
	}
}
