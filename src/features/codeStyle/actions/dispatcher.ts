import { logger } from '../../../shared/logger';
import type { ActionContext, ActionEffect, ActionResult, JsonValue } from './types';
import { ActionRegistry } from './registry';

const log = logger.scope('code-style');

/** Strict runtime DTO validation: JSON.stringify alone silently drops invalid fields. */
function isJson(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') { return true; }
	if (typeof value === 'number') { return Number.isFinite(value); }
	if (typeof value !== 'object' || depth > 100 || ancestors.has(value)) { return false; }
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value) ? prototype !== Array.prototype
		: prototype !== Object.prototype && prototype !== null) { return false; }
	ancestors.add(value);
	try {
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) { return false; }
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if ((!descriptor.enumerable && !(Array.isArray(value) && key === 'length')) ||
				!('value' in descriptor) || !isJson(descriptor.value, ancestors, depth + 1)) { return false; }
		}
		if (Array.isArray(value) && (value.length > 100000 || !Array.from({ length: value.length },
			(_, index) => Object.hasOwn(value, index)).every(Boolean))) { return false; }
		return true;
	} finally { ancestors.delete(value); }
}
function copy(value: JsonValue): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function validError(error: unknown): boolean {
	if (error === undefined) { return true; }
	if (!isJson(error) || error === null || Array.isArray(error) ||
		!Object.hasOwn(error, 'code') || !Object.hasOwn(error, 'message') ||
		!(typeof (error as { code?: unknown }).code === 'string') ||
		!(typeof (error as { message?: unknown }).message === 'string')) { return false; }
	const record = error as Record<string, unknown>;
	return Object.entries(record).every(([key, value]) =>
		['code', 'message', 'projectKey', 'sourceKey', 'ruleId', 'targetKey', 'sourceKind'].includes(key) &&
		typeof value === 'string'
	);
}
/** Effects declare capabilities; a sourceWrite operation has no permission in Task 1. */
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
				error: { code: 'unknownAction', message: 'Действие не зарегистрировано: ' + id } };
		}
		if (!this.mayExecute(action.effect)) {
			return { success: false, incomplete: false,
				error: { code: 'forbidden', message: 'Действие требует отдельного разрешения.' } };
		}
		try {
			if (!isJson(input)) { throw new Error('Входные параметры не являются JSON-данными.'); }
			const validated = action.validate(copy(input));
			if (!isJson(validated)) { throw new Error('Валидатор вернул некорректные JSON-данные.'); }
			const answer = await action.handle(this.context, copy(validated));
			if (!answer || typeof answer.success !== 'boolean' || typeof answer.incomplete !== 'boolean' ||
				(answer.data !== undefined && !isJson(answer.data)) || !validError(answer.error)) {
				throw new Error('Некорректный ответ действия.');
			}
			return { success: answer.success, incomplete: answer.incomplete,
				data: answer.data === undefined ? undefined : copy(answer.data),
				error: answer.error ? { ...answer.error } : undefined };
		} catch (error) {
			log.error('Действие ' + id + ': ' + (error instanceof Error ? error.stack ?? error.message : error));
			return { success: false, incomplete: false,
				error: { code: 'actionFailed', message: error instanceof Error ? error.message : String(error) } };
		}
	}
}
