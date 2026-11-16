import { RULE_AREAS, RULE_CATEGORIES, SEVERITIES, SOURCE_KINDS } from './types';
import type { RuleDefinition, RuleArea, RuleCategory, SourceKind, ProjectSettings } from './types';
import { compareText } from './identity';

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	typeof value === 'string' && list.includes(value as T);
const validText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const validOption = (value: unknown): boolean => {
	if (!value || typeof value !== 'object') { return false; }
	const option = value as {type?: unknown; default?: unknown; choices?: unknown; min?: unknown; max?: unknown};
	if (!oneOf(['boolean', 'string', 'number', 'enum'], option.type)) { return false; }
	if (option.type === 'number') {
		return typeof option.default === 'number' && Number.isFinite(option.default) &&
			(option.min === undefined || typeof option.min === 'number') &&
			(option.max === undefined || typeof option.max === 'number') &&
			(option.min === undefined || (typeof option.min === 'number' && option.default >= option.min)) &&
			(option.max === undefined || (typeof option.max === 'number' && option.default <= option.max));
	}
	if (option.type === 'enum') {
		return typeof option.default === 'string' && Array.isArray(option.choices) &&
			option.choices.length > 0 && option.choices.every(validText) && option.choices.includes(option.default);
	}
	return typeof option.default === option.type;
};

export class RuleRegistry {
	private readonly entries = new Map<string, RuleDefinition>();

	register(definition: RuleDefinition): void {
		if (!definition || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.id) ||
			!validText(definition.title) || !validText(definition.description) ||
			!oneOf(RULE_AREAS, definition.area) || !oneOf(RULE_CATEGORIES, definition.category) ||
			!oneOf(SEVERITIES, definition.defaultSeverity) || typeof definition.defaultEnabled !== 'boolean' ||
			!Array.isArray(definition.sourceKinds) || definition.sourceKinds.length === 0 ||
			!definition.sourceKinds.every((kind) => oneOf(SOURCE_KINDS, kind)) ||
			new Set(definition.sourceKinds).size !== definition.sourceKinds.length ||
			typeof definition.check !== 'function' ||
			(definition.supportsTarget !== undefined && typeof definition.supportsTarget !== 'function') ||
			(definition.fix !== undefined && typeof definition.fix !== 'function') ||
			(definition.options !== undefined && (typeof definition.options !== 'object' || definition.options === null ||
				Object.entries(definition.options).some(([name, value]) => !/^[a-z][a-zA-Z0-9]*$/.test(name) || !validOption(value))))) {
			throw new Error('Некорректное определение правила Code Style.');
		}
		if (this.entries.has(definition.id)) {
			throw new Error(`Правило Code Style уже зарегистрировано: ${definition.id}`);
		}
		this.entries.set(definition.id, definition);
	}

	get(id: string): RuleDefinition | undefined { return this.entries.get(id); }
	list(): readonly RuleDefinition[] { return [...this.entries.values()].sort((a, b) => compareText(a.id, b.id)); }
	select(settings: ProjectSettings, filters: {
		ruleIds?: readonly string[];
		areas?: readonly RuleArea[];
		categories?: readonly RuleCategory[];
		kinds?: readonly SourceKind[];
	} = {}): readonly RuleDefinition[] {
		if (!settings.enabled) { return []; }
		return this.list().filter((rule) =>
			settings.rules[rule.id]?.enabled &&
			(!filters.ruleIds || filters.ruleIds.includes(rule.id)) &&
			(!filters.areas || filters.areas.includes(rule.area)) &&
			(!filters.categories || filters.categories.includes(rule.category)) &&
			(!filters.kinds || rule.sourceKinds.some((kind) => filters.kinds?.includes(kind)))
		);
	}
}
