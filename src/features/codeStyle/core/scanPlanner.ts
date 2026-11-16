import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { filePath, projectByExplicitRoot } from '../sources/projectSource';
import { fileFingerprint } from '../sources/bslSource';
import { SourceRegistry } from '../sources/sourceRegistry';
import { RuleRegistry } from './ruleRegistry';
import { SettingsProvider } from './settings';
import { CodeStyleEngine } from './engine';
import { IssueStore, type CommitTicket } from './issueStore';
import { compareText, projectKeyOf, targetCompare } from './identity';
import type {
	CodeStyleError, PairResult, ProjectRef, ScanResult, ScanScope, SourceKind, SourceInventory,
} from './types';

const log = logger.scope('code-style');

function result(scope: ScanScope, runId: string, projectKey: string, status: ScanResult['status'],
	errors: readonly CodeStyleError[] = []): ScanResult {
	return { runId, projectKey, requested: scope, actualTargets: [], pairs: [],
		complete: status === 'completed' || status === 'noApplicableRules',
		status, issues: 0, errors };
}

/**
 * Resolves the scope once; only Store can accept individual successful pairs.
 * A failed enumerate never authorizes full-inventory cleanup.
 */
export class ScanPlanner {
	constructor(
		private readonly rules: RuleRegistry,
		private readonly sources: SourceRegistry,
		private readonly settings: SettingsProvider,
		private readonly engine: CodeStyleEngine,
		private readonly store: IssueStore
	) {}

	async scan(scope: ScanScope, runId: string, sequence: number, token: vscode.CancellationToken): Promise<ScanResult> {
		const key = projectKeyOf(scope.projectRoot);
		const finish = (scan: ScanResult): ScanResult => { this.store.recordScan(scan); return scan; };
		if (token.isCancellationRequested) { return finish(result(scope, runId, key, 'cancelled')); }
		if (this.rules.list().length === 0) { return finish(result(scope, runId, key, 'noApplicableRules')); }
		// Resolve effective enablement before expensive project layouts or metadata runtime calls.
		const initial = this.settings.safeRead(scope.projectRoot);
		if (!initial.settings) {
			return finish(result(scope, runId, key, 'error', [{
				code: 'invalidSettings', message: initial.error ?? 'Настройки недоступны.', projectKey: key,
			}]));
		}
		if (this.rules.select(initial.settings, { ruleIds: scope.ruleIds, kinds: scope.sourceKinds }).length === 0) {
			return finish(result(scope, runId, key, 'noApplicableRules'));
		}
		let project: ProjectRef | undefined;
		try { project = await projectByExplicitRoot(scope.projectRoot); }
		catch (error) {
			return finish(result(scope, runId, key, 'error', [{ code: 'projectResolveFailed', message: String(error), projectKey: key }]));
		}
		if (!project) {
			return finish(result(scope, runId, key, 'unsupported',
				[{ code: 'unknownProject', message: 'Проект не найден в известных проектах и кандидатах.', projectKey: key }]));
		}
		const configured = this.settings.safeRead(project.root);
		if (!configured.settings) {
			return finish(result(scope, runId, key, 'error', [{ code: 'invalidSettings', message: configured.error ?? 'Настройки недоступны.', projectKey: key }]));
		}
		const effective = configured.settings;
		this.store.setRuleRevisions(key, Object.fromEntries(Object.entries(effective.rules).map(([id, s]) => [id, s.revision])));
		const selected = this.rules.select(effective, { ruleIds: scope.ruleIds, kinds: scope.sourceKinds });
		if (selected.length === 0) { return finish(result(scope, runId, key, 'noApplicableRules')); }
		const kinds = [...new Set(selected.flatMap((rule) => rule.sourceKinds)
			.filter((kind) => !scope.sourceKinds || scope.sourceKinds.includes(kind))
			.filter((kind) => {
				// A BSL-only save must not load the metadata tree.
				if (scope.mode !== 'partial' || !scope.files?.length || scope.targetKeys?.length) { return true; }
				if (kind === 'bsl') { return scope.files.some((uri) => filePath(uri)?.toLowerCase().endsWith('.bsl')); }
				if (kind === 'metadata') { return scope.files.some((uri) => /\.(xml|mdo)$/i.test(filePath(uri) ?? '')); }
				return true;
			}))].sort(compareText);
		if (kinds.length === 0) { return finish(result(scope, runId, key, 'noApplicableRules')); }
		const inventoryEpoch = this.store.inventoryRevision(key);
		const projectEpoch = this.store.projectGeneration(key);
		const inventories = new Map<SourceKind, SourceInventory>();
		const errors: CodeStyleError[] = [];
		let enumerateComplete = true, unsupported = false;
		for (const kind of kinds) {
			if (token.isCancellationRequested) { enumerateComplete = false; break; }
			const provider = this.sources.get(kind);
			if (!provider) {
				unsupported = true; enumerateComplete = false;
				errors.push({ code: 'unsupportedSourceKind', message: `Не зарегистрирован поставщик ${kind}.`, projectKey: key });
				continue;
			}
			try {
				const inventory = await provider.enumerate(project, scope.mode === 'partial'
					? { files: scope.files, targetKeys: scope.targetKeys } : {}, token);
				inventories.set(kind, inventory);
				errors.push(...inventory.errors);
				if (!inventory.complete) { enumerateComplete = false; }
			} catch (error) {
				enumerateComplete = false;
				errors.push({ code: 'sourceEnumerateFailed', message: String(error), projectKey: key });
				log.error(`Перечисление ${kind}: ${error instanceof Error ? error.stack ?? error.message : error}`);
			}
		}
		const allTargets = [...inventories.values()].flatMap((inventory) => inventory.targets).sort(targetCompare);
		const pairs: PairResult[] = [];
		const applicable = new Set<string>();
		const inventoryRevision = [...inventories.entries()].map(([kind, item]) => `${kind}:${item.revision}`).sort().join('|');
		
		for (const target of allTargets) {
			if (token.isCancellationRequested) { break; }
			const provider = this.sources.get(target.sourceKind)!;
			const candidateRules = selected.filter((rule) => rule.sourceKinds.includes(target.sourceKind));
			// Capture file/project generations before the asynchronous checks start.
			const tickets = new Map<string, CommitTicket>();
			for (const rule of candidateRules) {
				tickets.set(rule.id, this.store.ticket({
					runId, sequence, projectKey: key, ruleId: rule.id, target,
					settingsRevision: effective.rules[rule.id].revision, sourceVersion: '', cancellation: token,
				}));
			}
			try {
				const executed = await this.engine.checkTarget(project, target, provider, candidateRules, effective.rules, token);
				for (const pair of executed.pairs) {
					const original = tickets.get(pair.ruleId)!;
					const pairId = IssueStore.pairId(key, pair.ruleId, target.targetKey);
					if (pair.status !== 'skipped') { applicable.add(pairId); }
					if (pair.status !== 'completed') {
						if (pair.status !== 'skipped') { this.store.fail(original, pair.status, pair.error); }
						pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey, status: pair.status, issues: 0, error: pair.error });
						if (pair.error) { errors.push(pair.error); }
						continue;
					}
					const ticket: CommitTicket = {
						...original, sourceVersion: pair.sourceVersion,
						dependencies: pair.dependencies.map((dep) => ({
							uri: dep.uri, version: dep.version, generation: this.store.fileGeneration(dep.uri),
						})),
					};
					let upToDate = false;
					try {
						const file = filePath(target.uri);
						const freshSettings = this.settings.read(project.root).rules[pair.ruleId];
						upToDate = !!file && !!freshSettings && freshSettings.revision === ticket.settingsRevision &&
							(await fileFingerprint(file)) === ticket.sourceVersion;
						if (upToDate) {
							for (const dep of ticket.dependencies) {
								const path = filePath(dep.uri);
								if (!path || (await fileFingerprint(path)) !== dep.version) { upToDate = false; break; }
							}
						}
					} catch { upToDate = false; }
					const accepted = upToDate && this.store.commit(ticket,
						pair.issues.map((issue) => ({ ...issue, sourceVersion: ticket.sourceVersion })));
					pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey,
						status: accepted ? 'completed' : 'stale', issues: accepted ? pair.issues.length : 0 });
									}
			} catch (error) {
				const technical: CodeStyleError = {
					code: 'targetCheckFailed', message: String(error), projectKey: key, targetKey: target.targetKey,
				};
				errors.push(technical);
				log.error(`Проверка цели: ${error instanceof Error ? error.stack ?? error.message : error}`);
				for (const rule of candidateRules) {
					const ticket = tickets.get(rule.id)!;
					applicable.add(IssueStore.pairId(key, rule.id, target.targetKey));
					this.store.fail(ticket, 'error', technical);
					pairs.push({ ruleId: rule.id, targetKey: target.targetKey, status: 'error', issues: 0, error: technical });
				}
			}
		}
		if (scope.mode === 'full' && enumerateComplete && !token.isCancellationRequested) {
			this.store.reconcileFull({
				projectKey: key, projectGeneration: projectEpoch, inventoryGeneration: inventoryEpoch, sequence,
				ruleIds: selected.map((rule) => rule.id), kinds, applicablePairs: applicable,
			});
		}
		const finished = !token.isCancellationRequested && enumerateComplete &&
			pairs.every((pair) => pair.status === 'completed' || pair.status === 'skipped');
		const status: ScanResult['status'] = token.isCancellationRequested ? 'cancelled'
			: unsupported && inventories.size === 0 ? 'unsupported'
				: finished ? 'completed'
					: (allTargets.length === 0 ? 'error' : 'partial');
		const final: ScanResult = {
			runId, projectKey: key, requested: scope, actualTargets: allTargets.map((target) => target.targetKey),
			pairs, inventoryRevision, complete: finished,
			status, issues: this.store.getIssues({ projectKey: key }).length, errors,
		};
		return finish(final);
	}
}
