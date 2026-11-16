import type { ActionDefinition } from './types';
export class ActionRegistry {
	private readonly definitions = new Map<string, ActionDefinition>();
	register(action: ActionDefinition): void {
		if (!action || !/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/.test(action.id) ||
			!action.title?.trim() || !action.description?.trim() ||
			!['read', 'settingsWrite', 'sourceWrite'].includes(action.effect) ||
			typeof action.validate !== 'function' || typeof action.handle !== 'function') {
			throw new Error('Некорректное определение действия Code Style.');
		}
		if (this.definitions.has(action.id)) { throw new Error(`Действие уже зарегистрировано: ${action.id}`); }
		this.definitions.set(action.id, action);
	}
	get(id: string): ActionDefinition | undefined { return this.definitions.get(id); }
	list(): readonly ActionDefinition[] {
		return [...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
	}
}
