import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { filePath, projectByExplicitRoot } from '../sources/projectSource';
import { SourceRegistry } from '../sources/sourceRegistry';
import { RuleRegistry } from './ruleRegistry';
import { SettingsProvider } from './settings';
import { CodeStyleEngine } from './engine';
import { IssueStore, type CommitTicket } from './issueStore';
import { compareText, projectKeyOf, targetCompare } from './identity';
import type {
	CodeStyleError, PairResult, ScanResult, ScanScope, SourceKind, SourceInventory, TargetDescriptor,
} from './types';

const log = logger.scope('code-style');

function result(scope: ScanScope, runId: string, projectKey: string, status: ScanResult['status'],
	errors: readonly CodeStyleError[] = []): ScanResult {
	return { runId, projectKey, requested: scope, actualTargets: [], pairs: [],
		complete: status === 'completed' || status === 'noApplicableRules',
		status, issues: 0, errors };
}
function requestedErrors(scope: ScanScope, targets: readonly TargetDescriptor[], key: string): CodeStyleError[] {
	if (scope.mode !== 'partial') { return []; }
	const foundFiles = new Set(targets.map((target) => target.uri));
	const foundTargets = new Set(targets.map((target) => target.targetKey));
	const errors: CodeStyleError[] = [];
	for (const uri of scope.files ?? []) {
		let normalized: string | undefined;
		try {
			const value = vscode.Uri.parse(uri);
			if (value.scheme === 'file') { normalized = value.toString(); }
		} catch { /* Report as unsupported below. */ }
		if (!normalized || !filePath(normalized)) {
			errors.push({ code: 'unsupportedSource', projectKey: key, message: 'Ожидался файловый URI: ' + uri });
		} else if (!foundFiles.has(normalized)) {
			errors.push({ code: 'unknownTarget', projectKey: key, message: 'Файл не был найден в выбранных источниках: ' + uri });
		}
	}
	for (const target of scope.targetKeys ?? []) {
		if (!foundTargets.has(target)) {
			errors.push({ code: 'unknownTarget', projectKey: key, targetKey: target,
				message: 'Цель не найдена в источниках выбранного проекта.' });
		}
	}
	return errors;
}

/** Converts explicit scopes to inventories; IssueStore is the sole commit authority. */
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
		const initial = this.settings.safeRead(scope.projectRoot);
		if (!initial.settings) {
			return finish(result(scope, runId, key, 'error', [
				{ code: 'invalidSettings', message: initial.error ?? 'Настройки недоступны.', projectKey: key },
			]));
		}
		const effective = initial.settings;
		if (this.rules.select(effective, { ruleIds: scope.ruleIds, kinds: scope.sourceKinds }).length === 0) {
			return finish(result(scope, runId, key, 'noApplicableRules'));
		}
		const project = await projectByExplicitRoot(scope.projectRoot).catch((error: unknown) => {
			log.error('Проект: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
			return undefined;
		});
		if (!project) {
			return finish(result(scope, runId, key, 'unsupported',
				[{ code: 'unknownProject', message: 'Проект не найден в известных проектах и кандидатах.', projectKey: key }]));
		}
		this.store.setRuleRevisions(key, Object.fromEntries(
			Object.entries(effective.rules).map(([id, settings]) => [id, settings.revision])
		));
		const selected = this.rules.select(effective, { ruleIds: scope.ruleIds, kinds: scope.sourceKinds });
		const kinds = [...new Set(selected.flatMap((rule) => rule.sourceKinds)
			.filter((kind) => !scope.sourceKinds || scope.sourceKinds.includes(kind))
			.filter((kind) => {
				if (scope.mode !== 'partial' || !scope.files?.length || scope.targetKeys?.length) { return true; }
				if (kind === 'bsl') { return scope.files.some((uri) => filePath(uri)?.toLowerCase().endsWith('.bsl')); }
				if (kind === 'metadata') { return scope.files.some((uri) => /\.(xml|mdo)$/i.test(filePath(uri) ?? '')); }
				return true;
			}))].sort(compareText);
		if (kinds.length === 0) {
			const explicit = scope.mode === 'partial' && Boolean(scope.files?.length || scope.targetKeys?.length);
			return finish(result(scope, runId, key, explicit ? 'unsupported' : 'noApplicableRules',
				explicit ? [{ code: 'unsupportedSource', message: 'Нет подходящего поставщика для запрошенной цели.', projectKey: key }] : []));
		}
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
				errors.push({ code: 'unsupportedSourceKind', message: 'Не зарегистрирован поставщик ' + kind, projectKey: key });
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
				log.error('Перечисление ' + kind + ': ' + (error instanceof Error ? error.stack ?? error.message : error));
			}
		}
		const allTargets = [...inventories.values()].flatMap((inventory) => inventory.targets).sort(targetCompare);
		const missing = requestedErrors(scope, allTargets, key);
		errors.push(...missing);
		const pairs: PairResult[] = [];
		const checkedTargets = new Set<string>();
		const applicable = new Set<string>();
		const inventoryRevision = [...inventories.entries()]
			.map(([kind, item]) => kind + ':' + item.revision).sort(compareText).join('|');
		for (const target of allTargets) {
			if (token.isCancellationRequested) { break; }
			const provider = this.sources.get(target.sourceKind)!;
			const candidateRules = selected.filter((rule) => rule.sourceKinds.includes(target.sourceKind));
			const tickets = new Map<string, CommitTicket>();
			for (const rule of candidateRules) {
				tickets.set(rule.id, this.store.ticket({
					runId, sequence, projectKey: key, ruleId: rule.id, target,
					settingsRevision: effective.rules[rule.id].revision, sourceVersion: '', cancellation: token,
				}));
			}
			try {
				const executed = await this.engine.checkTarget(project, target, provider, candidateRules,
					effective.rules, token, (uri) => this.store.fileGeneration(uri));
				for (const pair of executed.pairs) {
					const original = tickets.get(pair.ruleId)!;
					const pairId = IssueStore.pairId(key, pair.ruleId, target.targetKey);
					if (pair.status !== 'skipped') { applicable.add(pairId); }
					if (pair.status === 'skipped') {
						this.store.deactivatePair(original);
						pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey, status: 'skipped', issues: 0 });
						continue;
					}
					if (pair.status !== 'completed') {
						this.store.fail(original, pair.status, pair.error);
						pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey, status: pair.status, issues: 0, error: pair.error });
						if (pair.error) { errors.push(pair.error); }
						continue;
					}
					const ticket: CommitTicket = {
						...original, sourceVersion: pair.sourceVersion,
						dependencies: pair.dependencies,
					};
					const accepted = await this.store.commit(ticket, pair.issues);
					pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey,
						status: accepted ? 'completed' : 'stale', issues: accepted ? pair.issues.length : 0 });
					if (accepted) { checkedTargets.add(target.targetKey); }
				}
			} catch (error) {
				const technical: CodeStyleError = {
					code: 'targetCheckFailed', message: String(error), projectKey: key, targetKey: target.targetKey,
				};
				errors.push(technical);
				log.error('Проверка цели: ' + (error instanceof Error ? error.stack ?? error.message : error));
				for (const rule of candidateRules) {
					const ticket = tickets.get(rule.id)!;
					applicable.add(IssueStore.pairId(key, rule.id, target.targetKey));
					this.store.fail(ticket, 'error', technical);
					pairs.push({ ruleId: rule.id, targetKey: target.targetKey, status: 'error', issues: 0, error: technical });
				}
			}
		}
		if (scope.mode === 'full' && enumerateComplete && !token.isCancellationRequested &&
			this.store.inventoryRevision(key) === inventoryEpoch) {
			this.store.reconcileFull({
				projectKey: key, projectGeneration: projectEpoch, inventoryGeneration: inventoryEpoch, sequence,
				ruleIds: selected.map((rule) => rule.id), kinds, applicablePairs: applicable,
			});
		}
		const allSkipped = pairs.every((pair) => pair.status === 'skipped');
		const finished = !token.isCancellationRequested && enumerateComplete && errors.length === 0 &&
			pairs.every((pair) => pair.status === 'completed' || pair.status === 'skipped');
		let status: ScanResult['status'];
		if (token.isCancellationRequested) { status = 'cancelled'; }
		else if (unsupported && inventories.size === 0) { status = 'unsupported'; }
		else if (missing.length > 0 && checkedTargets.size === 0) { status = 'unsupported'; }
		else if (pairs.length > 0 && pairs.every((pair) =>
			pair.status === 'unsupported' || pair.status === 'skipped')) { status = 'unsupported'; }
		else if (finished && allSkipped) { status = 'noApplicableRules'; }
		else if (finished) { status = 'completed'; }
		else { status = checkedTargets.size === 0 ? 'error' : 'partial'; }
		const final: ScanResult = {
			runId, projectKey: key, requested: scope, actualTargets: [...checkedTargets].sort(compareText),
			pairs, inventoryRevision, complete: finished, status,
			issues: this.store.getIssues({ projectKey: key }).length, errors,
		};
		return finish(final);
	}
}
