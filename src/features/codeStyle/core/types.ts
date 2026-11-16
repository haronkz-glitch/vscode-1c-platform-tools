import type * as vscode from 'vscode';
import type { SourceFormat, ProjectLayout } from '../../../shared/projectLayout';

export const RULE_AREAS = ['bsl', 'metadata', 'forms', 'queries', 'rights'] as const;
export type RuleArea = typeof RULE_AREAS[number];
export const RULE_CATEGORIES = ['style', 'metadata', 'performance', 'security', 'reliability', 'compatibility'] as const;
export type RuleCategory = typeof RULE_CATEGORIES[number];
export const SOURCE_KINDS = ['bsl', 'metadata', 'form', 'query', 'rights'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
export type Severity = typeof SEVERITIES[number];

export interface CodeStyleError {
	readonly code: string;
	readonly message: string;
	readonly projectKey?: string;
	readonly targetKey?: string;
	readonly ruleId?: string;
	readonly sourceKind?: SourceKind;
}

export interface ProjectRef {
	readonly key: string;
	readonly root: string;
	readonly layout: ProjectLayout;
	readonly candidate: boolean;
	/** Deeper registered projects/candidates belong to their own lifecycle. */
	readonly excludedRoots: readonly string[];
}

export interface SourceRef {
	readonly projectKey: string;
	readonly key: string;
	readonly root: string;
	readonly kind: 'configuration' | 'extension' | 'processor' | 'report';
	readonly format: SourceFormat;
	readonly entry: string;
}

/** Only inexpensive facts belong here; detailed properties remain lazy. */
export interface TargetDescriptor {
	readonly projectKey: string;
	readonly sourceKey: string;
	readonly targetKey: string;
	readonly sourceKind: SourceKind;
	readonly uri: string;
	readonly sourceRoot: string;
	readonly format: SourceFormat;
	readonly objectType?: string;
	readonly name?: string;
	readonly isSourceRoot?: boolean;
	readonly metadata?: {
		readonly configurationFile: string;
		readonly objectFile: string;
		readonly schemaVersion?: string;
		readonly schemaSupported?: boolean;
	};
}

export interface TargetSnapshot {
	readonly kind: SourceKind;
	readonly uri: string;
	readonly version: string;
	readonly text?: string;
	readonly dto?: unknown;
}
export interface DependencySnapshot {
	readonly uri: string;
	readonly version: string;
	readonly text: string;
}
export interface SourceInventory {
	readonly targets: readonly TargetDescriptor[];
	readonly complete: boolean;
	readonly revision: string;
	readonly errors: readonly CodeStyleError[];
}
export interface SourceSelection {
	readonly files?: readonly string[];
	readonly targetKeys?: readonly string[];
	readonly sourceKeys?: readonly string[];
}
export interface SourceProvider {
	readonly kind: SourceKind;
	enumerate(project: ProjectRef, selection: SourceSelection, token: vscode.CancellationToken): Promise<SourceInventory>;
	read(project: ProjectRef, target: TargetDescriptor, token: vscode.CancellationToken): Promise<TargetSnapshot>;
}

export interface PositionDto { readonly line: number; readonly character: number }
export interface RangeDto { readonly start: PositionDto; readonly end: PositionDto }
export interface IssueLocation { readonly uri: string; readonly range: RangeDto }
export interface FixAvailability {
	readonly kind: string;
	readonly description?: string;
}
export interface RuleIssue {
	readonly message: string;
	readonly location: IssueLocation;
	readonly anchor?: string;
	readonly relatedLocations?: readonly IssueLocation[];
	readonly fix?: FixAvailability;
}
export interface Issue extends RuleIssue {
	readonly id: string;
	readonly ruleId: string;
	readonly area: RuleArea;
	readonly category: RuleCategory;
	readonly severity: Severity;
	readonly projectKey: string;
	readonly sourceKey: string;
	readonly targetKey: string;
	readonly sourceKind: SourceKind;
	readonly sourceVersion: string;
}
export interface RuleOptionDefinition {
	readonly type: 'boolean' | 'string' | 'number' | 'enum';
	readonly default: string | boolean | number;
	readonly choices?: readonly string[];
	readonly min?: number;
	readonly max?: number;
}
export interface EffectiveRuleSettings {
	readonly enabled: boolean;
	readonly severity: Severity;
	readonly options: Readonly<Record<string, string | number | boolean>>;
	readonly revision: string;
}
export interface ProjectSettings {
	readonly projectKey: string;
	readonly enabled: boolean;
	readonly scanOnSave: boolean;
	readonly maxConcurrency: number;
	readonly categories: Readonly<Record<RuleCategory, boolean>>;
	readonly rules: Readonly<Record<string, EffectiveRuleSettings>>;
}

export interface RuleContext {
	readonly project: ProjectRef;
	readonly target: TargetDescriptor;
	readonly settings: EffectiveRuleSettings;
	/** Version of the persisted target snapshot, available even without detailed read(). */
	readonly cancellation: vscode.CancellationToken;
	readonly sourceVersion: string;
	read(): Promise<TargetSnapshot>;
	/** Only existing files belonging to the same project may be requested. */
	readRelated(uri: string): Promise<DependencySnapshot>;
}
export interface RuleDefinition {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly area: RuleArea;
	readonly category: RuleCategory;
	readonly defaultEnabled: boolean;
	readonly defaultSeverity: Severity;
	readonly sourceKinds: readonly SourceKind[];
	readonly options?: Readonly<Record<string, RuleOptionDefinition>>;
	readonly supportsTarget?: (target: TargetDescriptor) => boolean;
	readonly check: (context: RuleContext) => readonly RuleIssue[] | Promise<readonly RuleIssue[]>;
	/** Declaration only: no fix execution exists in Task 1. */
	readonly fix?: (issue: Issue) => unknown;
}
export interface ScanPair { readonly ruleId: string; readonly targetKey: string }
export interface ScanScope {
	readonly projectRoot: string;
	readonly mode: 'full' | 'partial';
	readonly files?: readonly string[];
	readonly targetKeys?: readonly string[];
	/** Exact (rule,target) pairs for dependency-triggered partial checks. */
	readonly pairs?: readonly ScanPair[];
	/** Restrict an inventory to recognized configuration/extension/external roots. */
	readonly sourceKeys?: readonly string[];
	readonly sourceKinds?: readonly SourceKind[];
	readonly ruleIds?: readonly string[];
}
export type RuleSummary = Pick<RuleDefinition, 'id' | 'area' | 'category' | 'sourceKinds'> & { readonly severity: Severity };
export type RuleDescriptor = Pick<RuleDefinition, 'id' | 'title' | 'description' | 'area' |
	'category' | 'defaultSeverity' | 'defaultEnabled' | 'sourceKinds'>;
export type ScanStatus = 'completed' | 'partial' | 'noApplicableRules' | 'cancelled' | 'stale' | 'error' | 'unsupported';
export type PairStatus = 'completed' | 'error' | 'cancelled' | 'stale' | 'unsupported' | 'skipped';
export interface PairResult {
	readonly ruleId: string;
	readonly targetKey: string;
	readonly status: PairStatus;
	readonly issues: number;
	readonly error?: CodeStyleError;
}
export interface ScanResult {
	readonly runId: string;
	readonly projectKey: string;
	readonly requested: ScanScope;
	readonly selectedRules?: readonly RuleSummary[];
	/** Per-kind inventory completeness for filtered result summaries. */
	readonly sourceCompleteness?: Partial<Record<SourceKind, boolean>>;
	readonly inventoryCurrent?: boolean;
	/** Store inventory generation captured for this run. */
	readonly inventoryEpoch?: number;
	readonly actualTargets: readonly string[];
	readonly pairs: readonly PairResult[];
	readonly inventoryRevision?: string;
	readonly complete: boolean;
	readonly status: ScanStatus;
	readonly issues: number;
	readonly errors: readonly CodeStyleError[];
}
export interface IssueFilter {
	readonly projectKey?: string;
	readonly sourceKey?: string;
	readonly targetKey?: string;
	readonly uri?: string;
	readonly ruleId?: string;
	readonly area?: RuleArea;
	readonly category?: RuleCategory;
	readonly severity?: Severity;
	readonly status?: 'current' | 'stale' | 'all';
}
export interface IssueQueryResult {
	readonly issues: readonly Issue[];
	readonly scans: readonly ScanResult[];
	readonly pairStates: readonly { projectKey: string; ruleId: string; targetKey: string; status: PairStatus; stale: boolean; area: RuleArea; category: RuleCategory; severity: Severity; sourceKey: string; error?: CodeStyleError }[];
	readonly errors: readonly CodeStyleError[];
	readonly complete: boolean;
}
export interface StoreChange {
	readonly reason: 'commit' | 'invalidate' | 'remove' | 'settings';
	readonly uris: readonly string[];
	readonly projectKeys: readonly string[];
	readonly ruleIds: readonly string[];
}
