import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { compareText, issueLocationValid, stableIssueId } from './identity';
import { persistedVersion, readPersisted, SourceDataError, sourceError } from './sourceVersion';
import type {
	CodeStyleError, DependencySnapshot, EffectiveRuleSettings, Issue, ProjectRef, RuleDefinition,
	RuleIssue, SourceProvider, TargetDescriptor, TargetSnapshot, PairStatus,
} from './types';
import { ensureOwnedUri, fileUri } from '../sources/projectSource';

const log = logger.scope('code-style');

export interface EnginePair {
	readonly ruleId: string;
	readonly target: TargetDescriptor;
	readonly status: PairStatus;
	readonly issues: readonly Issue[];
	readonly sourceVersion: string;
	readonly dependencies: readonly { uri: string; version: string; generation: number }[];
	readonly error?: CodeStyleError;
}
export interface EngineTargetResult {
	readonly pairs: readonly EnginePair[];
	readonly sourceVersion: string;
}

/** Checks descriptors first and shares at most one detailed read per target. */
export class CodeStyleEngine {
	async checkTarget(
		project: ProjectRef, target: TargetDescriptor, provider: SourceProvider,
		rules: readonly RuleDefinition[], settings: Readonly<Record<string, EffectiveRuleSettings>>,
		token: vscode.CancellationToken, generationOf: (uri: string) => number
	): Promise<EngineTargetResult> {
		const results: EnginePair[] = [];
		const selected: RuleDefinition[] = [];
		const failure = (rule: RuleDefinition, status: PairStatus, code: string, error: unknown, version = ''): EnginePair => {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof Error) { log.error(rule.id + ': ' + (error.stack ?? message)); }
			return { ruleId: rule.id, target, status, issues: [], sourceVersion: version,
				dependencies: [], error: { code, message, projectKey: project.key,
					targetKey: target.targetKey, ruleId: rule.id } };
		};

		for (const rule of [...rules].sort((a, b) => compareText(a.id, b.id))) {
			if (!rule.sourceKinds.includes(target.sourceKind) || !settings[rule.id]?.enabled) { continue; }
			if (token.isCancellationRequested) {
				results.push(failure(rule, 'cancelled', 'cancelled', 'Операция отменена.'));
				continue;
			}
			try {
				if (rule.supportsTarget?.(target) === false) {
					results.push({ ruleId: rule.id, target, status: 'skipped', issues: [], sourceVersion: '', dependencies: [] });
					continue;
				}
				selected.push(rule);
			} catch (error) {
				results.push(failure(rule, 'error', 'supportsTargetFailed', error));
			}
		}
		if (selected.length === 0) { return { pairs: results, sourceVersion: '' }; }

		let sourceVersion: string;
		try { sourceVersion = await persistedVersion(target.uri); }
		catch (error) {
			const resolved = sourceError(error);
			for (const rule of selected) { results.push(failure(rule, 'error', resolved.code, resolved)); }
			return { pairs: results, sourceVersion: '' };
		}
		let detailed: Promise<TargetSnapshot> | undefined;
		let detailedFailure: SourceDataError | undefined;
		const read = (): Promise<TargetSnapshot> => {
			detailed ??= provider.read(project, target, token).then((snapshot) => {
				if (snapshot.version !== sourceVersion || snapshot.uri !== target.uri || snapshot.kind !== target.sourceKind) {
					throw new SourceDataError('staleSource', 'Подробные данные не соответствуют снимку цели.');
				}
				return snapshot;
			}).catch((error: unknown) => {
				detailedFailure = sourceError(error);
				throw detailedFailure;
			});
			return detailed;
		};
		const related = new Map<string, Promise<DependencySnapshot>>();
		const readRelated = (uri: string): Promise<DependencySnapshot> => {
			if (!related.has(uri)) {
				related.set(uri, (async () => {
					if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
					await ensureOwnedUri(project, uri);
					const snapshot = await readPersisted(uri);
					if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
					return { uri, version: snapshot.version, text: snapshot.bytes.toString('utf8') };
				})().catch((error: unknown) => { throw sourceError(error); }));
			}
			return related.get(uri)!;
		};

		for (const rule of selected) {
			if (token.isCancellationRequested) {
				results.push(failure(rule, 'cancelled', 'cancelled', 'Операция отменена.', sourceVersion));
				continue;
			}
			const used = new Map<string, number>();
			const capture = (uri: string): void => { if (!used.has(uri)) { used.set(uri, generationOf(uri)); } };
			let usedDetail = false;
			try {
				// The configuration schema/support is an implicit dependency of metadata objects.
				const configuration = target.metadata?.configurationFile;
				if (configuration && fileUri(configuration) !== target.uri) {
					capture(fileUri(configuration));
				}
				const raw = await Promise.resolve(rule.check({
					project, target, sourceVersion, settings: settings[rule.id], cancellation: token,
					read: () => { usedDetail = true; return read(); }, readRelated: (uri) => {
						capture(uri);
						return readRelated(uri);
					},
				}));
				if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
				if (detailedFailure && usedDetail) { throw detailedFailure; }
				if (!Array.isArray(raw)) { throw new Error('Правило должно возвращать массив замечаний.'); }
				const issues = await this.normalize(raw, rule, target, settings[rule.id].severity, project, sourceVersion);
				for (const issue of issues) {
					for (const location of issue.relatedLocations ?? []) {
						if (location.uri !== target.uri) { capture(location.uri); }
					}
					if (issue.location.uri !== target.uri) { capture(issue.location.uri); }
				}
				const dependencies = await Promise.all([...used].sort(([left], [right]) => compareText(left, right)).map(async ([uri, generation]) => ({
					uri, generation, version: (await readRelated(uri)).version,
				})));
				if (detailedFailure && usedDetail) { throw detailedFailure; }
				if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
				results.push({ ruleId: rule.id, target, status: 'completed', issues, sourceVersion, dependencies });
			} catch (error) {
				const resolved = error instanceof SourceDataError ? error : sourceError(error, 'ruleCheckFailed');
				const status: PairStatus = resolved.code === 'cancelled' ? 'cancelled'
					: resolved.code === 'unsupportedSource' ? 'unsupported'
						: (resolved.code === 'dirtySource' || resolved.code === 'staleSource') ? 'stale' : 'error';
				results.push(failure(rule, status, resolved.code, resolved, sourceVersion));
			}
		}
		return { pairs: results, sourceVersion };
	}

	private async normalize(raw: readonly RuleIssue[], rule: RuleDefinition, target: TargetDescriptor,
		severity: Issue['severity'], project: ProjectRef, sourceVersion: string): Promise<readonly Issue[]> {
		const validated: RuleIssue[] = [];
		for (const issue of raw) {
			if (!issue || typeof issue.message !== 'string' || !issue.message.trim() ||
				!issue.location || !issueLocationValid(issue.location) ||
				!Array.isArray(issue.relatedLocations ?? []) ||
				(issue.relatedLocations ?? []).some((location) => !issueLocationValid(location)) ||
				(issue.anchor !== undefined && (typeof issue.anchor !== 'string' || issue.anchor.length === 0))) {
				throw new Error('Правило вернуло некорректную локацию или сообщение.');
			}
			await ensureOwnedUri(project, issue.location.uri);
			for (const location of issue.relatedLocations ?? []) { await ensureOwnedUri(project, location.uri); }
			if (issue.fix !== undefined && !rule.fix) {
				throw new Error('Правило предложило исправление без контракта fix.');
			}
			validated.push(issue);
		}
		validated.sort((a, b) =>
			compareText(a.location.uri, b.location.uri) ||
			a.location.range.start.line - b.location.range.start.line ||
			a.location.range.start.character - b.location.range.start.character ||
			compareText(a.anchor ?? '', b.anchor ?? '') || compareText(a.message, b.message));
		const duplicates = new Map<string, number>();
		return validated.map((issue) => {
			const anchor = issue.anchor ?? JSON.stringify([issue.location.uri, issue.location.range, issue.message]);
			const occurrence = duplicates.get(anchor) ?? 0;
			duplicates.set(anchor, occurrence + 1);
			return {
				...issue, id: stableIssueId(rule.id, target, anchor, occurrence),
				ruleId: rule.id, area: rule.area, category: rule.category, severity,
				projectKey: target.projectKey, sourceKey: target.sourceKey,
				targetKey: target.targetKey, sourceKind: target.sourceKind,
				sourceVersion,
			};
		});
	}
}
