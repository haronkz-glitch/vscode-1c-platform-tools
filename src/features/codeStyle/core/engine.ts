import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { compareText, issueLocationValid, stableIssueId } from './identity';
import type {
	CodeStyleError, DependencySnapshot, EffectiveRuleSettings, Issue, ProjectRef, RuleDefinition,
	RuleIssue, SourceProvider, TargetDescriptor, TargetSnapshot, PairStatus,
} from './types';
import { ensureOwnedUri, filePath } from '../sources/projectSource';
import { fileFingerprint } from '../sources/bslSource';

const log = logger.scope('code-style');

export interface EnginePair {
	readonly ruleId: string;
	readonly target: TargetDescriptor;
	readonly status: PairStatus;
	readonly issues: readonly Issue[];
	readonly sourceVersion: string;
	readonly dependencies: readonly DependencySnapshot[];
	readonly error?: CodeStyleError;
}
export interface EngineTargetResult {
	readonly pairs: readonly EnginePair[];
	readonly sourceVersion: string;
}

/**
 * Runs independent rules against one descriptor. Detailed reads are shared per target,
 * and errors never turn a failed pair into an empty successful check.
 */
export class CodeStyleEngine {
	async checkTarget(
		project: ProjectRef, target: TargetDescriptor, provider: SourceProvider,
		rules: readonly RuleDefinition[], settings: Readonly<Record<string, EffectiveRuleSettings>>,
		token: vscode.CancellationToken
	): Promise<EngineTargetResult> {
		const file = filePath(target.uri);
		if (!file) { throw new Error('Для анализа требуется файловый URI.'); }
		const sourceVersion = await fileFingerprint(file);
		let data: Promise<TargetSnapshot> | undefined;
		const related = new Map<string, Promise<DependencySnapshot>>();
		const read = (): Promise<TargetSnapshot> => {
			data ??= provider.read(project, target, token);
			return data;
		};
		const readRelated = (uri: string): Promise<DependencySnapshot> => {
			if (!related.has(uri)) {
				related.set(uri, (async () => {
					if (token.isCancellationRequested) { throw new Error('Отменено.'); }
					const owned = await ensureOwnedUri(project, uri);
					const bytes = await fs.readFile(owned);
					if (token.isCancellationRequested) { throw new Error('Отменено.'); }
					return { uri, version: createHash('sha1').update(bytes).digest('hex'), text: bytes.toString('utf8') };
				})());
			}
			return related.get(uri)!;
		};
		const pairs: EnginePair[] = [];
		for (const rule of [...rules].sort((a, b) => compareText(a.id, b.id))) {
			if (!rule.sourceKinds.includes(target.sourceKind) || !settings[rule.id]?.enabled) { continue; }
			const usedDependencies = new Set<string>();
			const fail = (status: PairStatus, code: string, error: unknown): EnginePair => {
				const message = error instanceof Error ? error.message : String(error);
				if (error instanceof Error) { log.error(`${rule.id}: ${error.stack ?? message}`); }
				return { ruleId: rule.id, target, status, issues: [], sourceVersion, dependencies: [],
					error: { code, message, projectKey: project.key, targetKey: target.targetKey, ruleId: rule.id } };
			};
			if (token.isCancellationRequested) {
				pairs.push(fail('cancelled', 'cancelled', 'Операция отменена.'));
				continue;
			}
			let supported: boolean;
			try { supported = rule.supportsTarget ? rule.supportsTarget(target) : true; }
			catch (error) { pairs.push(fail('error', 'supportsTargetFailed', error)); continue; }
			if (!supported) {
				pairs.push({ ruleId: rule.id, target, status: 'skipped', issues: [], sourceVersion, dependencies: [] });
				continue;
			}
			try {
				const result = await Promise.resolve(rule.check({
					project, target, settings: settings[rule.id], cancellation: token, read,
					readRelated: (uri) => { usedDependencies.add(uri); return readRelated(uri); },
				}));
				if (token.isCancellationRequested) {
					pairs.push(fail('cancelled', 'cancelled', 'Операция отменена.'));
					continue;
				}
				if (!Array.isArray(result)) { throw new Error('Правило должно возвращать массив замечаний.'); }
				const dependencies = await Promise.all([...usedDependencies].map((uri) => related.get(uri)!));
				const issues = await this.normalize(result, rule, target, settings[rule.id].severity, project);
				pairs.push({ ruleId: rule.id, target, status: 'completed', issues,
					sourceVersion: (await data)?.version ?? sourceVersion,
					dependencies });
			} catch (error) {
				pairs.push(fail('error', 'ruleCheckFailed', error));
			}
		}
		return { pairs, sourceVersion };
	}

	private async normalize(raw: readonly RuleIssue[], rule: RuleDefinition, target: TargetDescriptor,
		severity: Issue['severity'], project: ProjectRef): Promise<readonly Issue[]> {
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
				sourceVersion: '',
			};
		});
	}
}
