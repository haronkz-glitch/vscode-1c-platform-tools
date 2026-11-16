import type { CodeStyleError, IssueFilter, IssueQueryResult, RuleDefinition, ScanResult, ScanScope, ProjectSettings } from '../core/types';

export type JsonValue = null | string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ActionEffect = 'read' | 'settingsWrite' | 'sourceWrite';
export interface ActionResult {
	readonly success: boolean;
	readonly incomplete: boolean;
	readonly data?: JsonValue;
	readonly error?: CodeStyleError;
}
/** Only restricted functions, never a mutable service or a VS Code object. */
export interface ActionContext {
	listRules(): readonly Pick<RuleDefinition, 'id' | 'title' | 'description' | 'area' | 'category' | 'defaultSeverity' | 'defaultEnabled' | 'sourceKinds'>[];
	getSettings(projectRoot: string): ProjectSettings | undefined;
	getIssues(filter?: IssueFilter): IssueQueryResult;
	check(scope: ScanScope): Promise<ScanResult>;
}
export interface ActionDefinition {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly effect: ActionEffect;
	/** Validate a JSON-compatible request and return the normalized payload, or throw. */
	readonly validate: (input: JsonValue) => JsonValue;
	readonly handle: (context: ActionContext, input: JsonValue) => ActionResult | Promise<ActionResult>;
}
