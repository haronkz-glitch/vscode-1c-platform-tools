import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { RULE_CATEGORIES, SEVERITIES } from './types';
import type { RuleCategory, ProjectSettings, EffectiveRuleSettings, RuleOptionDefinition, RuleDefinition } from './types';
import { projectKeyOf } from './identity';
import { RuleRegistry } from './ruleRegistry';
import { stableHash } from './identity';

const log = logger.scope('code-style');
const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function optionValue(name: string, schema: RuleOptionDefinition, raw: unknown): string | number | boolean {
	const value = raw === undefined ? schema.default : raw;
	const ok = schema.type === 'enum'
		? typeof value === 'string' && schema.choices?.includes(value) === true
		: schema.type === 'number'
			? typeof value === 'number' && Number.isFinite(value) &&
				(schema.min === undefined || value >= schema.min) &&
				(schema.max === undefined || value <= schema.max)
			: typeof value === schema.type;
	if (!ok) { throw new Error(`Некорректный параметр правила: ${name}`); }
	// The schema validation above guarantees the primitive type.
	return value as string | number | boolean;
}

export class SettingsProvider {
	constructor(private readonly registry: RuleRegistry) {}

	read(projectRoot: string): ProjectSettings {
		const cfg = vscode.workspace.getConfiguration('1c-platform-tools', vscode.Uri.file(projectRoot));
		const boolean = (name: string, defaultValue: boolean): boolean => {
			const v: unknown = cfg.get(`codeStyle.${name}`, defaultValue);
			if (typeof v !== 'boolean') { throw new Error(`codeStyle.${name}: ожидается boolean`); }
			return v;
		};
		const enabled = boolean('enabled', true);
		const scanOnSave = boolean('scanOnSave', true);
		const maxConcurrency: unknown = cfg.get('codeStyle.maxConcurrency', 2);
		if (typeof maxConcurrency !== 'number' || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
			throw new Error('codeStyle.maxConcurrency: допустимо целое число 1..8');
		}
		const categoriesRaw: unknown = cfg.get('codeStyle.categories', {});
		const rulesRaw: unknown = cfg.get('codeStyle.rules', {});
		if (!isRecord(categoriesRaw) || !isRecord(rulesRaw)) {
			throw new Error('codeStyle.categories и codeStyle.rules должны быть объектами');
		}
		const categories = {} as Record<RuleCategory, boolean>;
		for (const category of RULE_CATEGORIES) {
			const value = categoriesRaw[category] === undefined ? true : categoriesRaw[category];
			if (typeof value !== 'boolean') { throw new Error(`codeStyle.categories.${category}: ожидается boolean`); }
			categories[category] = value;
		}
		const rules: Record<string, EffectiveRuleSettings> = {};
		for (const rule of this.registry.list()) {
			rules[rule.id] = this.effectiveRule(rule, enabled, categories[rule.category], rulesRaw[rule.id]);
		}
		return { projectKey: projectKeyOf(projectRoot), enabled, scanOnSave, maxConcurrency, categories, rules };
	}

	private effectiveRule(rule: RuleDefinition, enabled: boolean, categoryEnabled: boolean, entry: unknown): EffectiveRuleSettings {
		if (entry !== undefined && !isRecord(entry)) { throw new Error(`codeStyle.rules.${rule.id}: ожидается объект`); }
		const config = (entry ?? {}) as Record<string, unknown>;
		if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
			throw new Error(`codeStyle.rules.${rule.id}.enabled: ожидается boolean`);
		}
		const severity = config.severity === undefined ? rule.defaultSeverity : config.severity;
		if (typeof severity !== 'string' || !SEVERITIES.includes(severity as typeof SEVERITIES[number])) {
			throw new Error(`codeStyle.rules.${rule.id}.severity: неизвестный уровень`);
		}
		if (config.options !== undefined && !isRecord(config.options)) {
			throw new Error(`codeStyle.rules.${rule.id}.options: ожидается объект`);
		}
		const requested = (config.options ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(requested)) {
			if (!rule.options?.[key]) { throw new Error(`Неизвестная опция: ${rule.id}.${key}`); }
		}
		const options: Record<string, string | number | boolean> = {};
		for (const [key, schema] of Object.entries(rule.options ?? {})) {
			options[key] = optionValue(`${rule.id}.${key}`, schema, requested[key]);
		}
		const ruleEnabled = enabled && categoryEnabled && ((config.enabled as boolean | undefined) ?? rule.defaultEnabled);
		return {
			enabled: ruleEnabled,
			severity: severity as EffectiveRuleSettings['severity'],
			options,
			revision: stableHash(String(ruleEnabled), severity,
				JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)))),
		};
	}

	/** Re-evaluate only one rule at commit, not all definitions for every checked pair. */
	revisionFor(projectRoot: string, ruleId: string): string | undefined {
		const rule = this.registry.get(ruleId);
		if (!rule) { return undefined; }
		const cfg = vscode.workspace.getConfiguration('1c-platform-tools', vscode.Uri.file(projectRoot));
		const enabled: unknown = cfg.get('codeStyle.enabled', true);
		const categories: unknown = cfg.get('codeStyle.categories', {});
		const rules: unknown = cfg.get('codeStyle.rules', {});
		if (typeof enabled !== 'boolean' || !isRecord(categories) || !isRecord(rules)) {
			throw new Error('Некорректные общие настройки Code Style.');
		}
		const category = categories[rule.category] === undefined ? true : categories[rule.category];
		if (typeof category !== 'boolean') { throw new Error(`codeStyle.categories.${rule.category}: ожидается boolean`); }
		return this.effectiveRule(rule, enabled, category, rules[rule.id]).revision;
	}

	/** Settings errors are technical failures, never silent defaults. */
	safeRead(root: string): { settings?: ProjectSettings; error?: string } {
		try { return { settings: this.read(root) }; }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(message);
			return { error: message };
		}
	}
}
