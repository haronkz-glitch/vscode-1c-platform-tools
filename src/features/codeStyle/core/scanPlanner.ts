import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { canonicalFileUri, compareText, projectKeyOf, targetCompare } from './identity';
import { filePath, projectByExplicitRoot } from '../sources/projectSource';
import { SourceRegistry } from '../sources/sourceRegistry';
import { RuleRegistry } from './ruleRegistry';
import { SettingsProvider } from './settings';
import { CodeStyleEngine } from './engine';
import { IssueStore, type CommitTicket } from './issueStore';
import type {
	CodeStyleError, PairResult, RuleDefinition, ScanResult, ScanScope, SourceKind, SourceInventory, TargetDescriptor,
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
	const foundFiles = new Set(targets.map((target) => canonicalFileUri(target.uri)));
	const foundTargets = new Set(targets.map((target) => target.targetKey));
	const errors: CodeStyleError[] = [];
	for (const uri of scope.files ?? []) {
		let normalized: string | undefined;
		try { normalized = canonicalFileUri(uri); } catch { /* Report unsupported below. */ }
		if (!normalized || !filePath(normalized)) {
			errors.push({ code: 'unsupportedSource', projectKey: key, message: 'Ожидался файловый URI: ' + uri });
		} else if (!foundFiles.has(normalized)) {
			errors.push({ code: 'unknownTarget', projectKey: key, message: 'Файл не найден в выбранных источниках: ' + uri });
		}
	}
	for (const targetKey of [...(scope.targetKeys ?? []), ...(scope.pairs ?? []).map((pair) => pair.targetKey)]) {
		if (!foundTargets.has(targetKey)) {
			errors.push({ code: 'unknownTarget', projectKey: key, targetKey,
				message: 'Цель не найдена в выбранном источнике.' });
		}
	}
	return errors;
}
function checkRules(target: TargetDescriptor, selected: readonly RuleDefinition[], scope: ScanScope): readonly RuleDefinition[] {
	const fromFile = scope.files?.some((uri) => {
		try { return canonicalFileUri(uri) === canonicalFileUri(target.uri); } catch { return false; }
	}) ?? false;
	const direct = scope.mode === 'full' || fromFile || (scope.targetKeys?.includes(target.targetKey) ?? false) ||
		(!scope.files?.length && !scope.targetKeys?.length && !scope.pairs?.length);
	return selected.filter((rule) =>
		rule.sourceKinds.includes(target.sourceKind) &&
		((direct && (!scope.ruleIds || scope.ruleIds.includes(rule.id))) ||
			(scope.pairs?.some((pair) => pair.ruleId === rule.id && pair.targetKey === target.targetKey) ?? false))
	);
}
/** Maps a scope to descriptors once, runs independent targets, and delegates commit to Store. */
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
		if (token.isCancellationRequested) { return result(scope, runId, key, 'cancelled'); }
		if (this.rules.list().length === 0) { return result(scope, runId, key, 'noApplicableRules'); }

		// Capture settings and register the current revision BEFORE any project-resolution await.
		// Commit will also re-check the live per-rule revision inside IssueStore.
		const configured = this.settings.safeRead(scope.projectRoot);
		if (!configured.settings) {
			return result(scope, runId, key, 'error', [{
				code: 'invalidSettings', message: configured.error ?? 'Настройки недоступны.', projectKey: key,
			}]);
		}
		const effective = configured.settings;
		this.store.setRuleRevisions(key, Object.fromEntries(
			Object.entries(effective.rules).map(([id, value]) => [id, value.revision])
		));
		const requestedIds = scope.ruleIds?.length || scope.pairs?.length
			? [...new Set([...(scope.ruleIds ?? []), ...(scope.pairs ?? []).map((pair) => pair.ruleId)])]
			: undefined;
		const selected = this.rules.select(effective, { ruleIds: requestedIds, kinds: scope.sourceKinds });
		if (selected.length === 0) { return result(scope, runId, key, 'noApplicableRules'); }

		let resolvedProject: Awaited<ReturnType<typeof projectByExplicitRoot>>;
		try { resolvedProject = await projectByExplicitRoot(scope.projectRoot); }
		catch (error) {
			log.error('Разрешение проекта: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
			return result(scope, runId, key, 'error', [{
				code: 'projectResolveFailed', message: error instanceof Error ? error.message : String(error),
				projectKey: key,
			}]);
		}
		if (!resolvedProject) {
			return result(scope, runId, key, 'unsupported', [{
				code: 'unknownProject', message: 'Проект отсутствует среди известных проектов и кандидатов.', projectKey: key,
			}]);
		}
		const project = resolvedProject;
		const selectedRules = selected.map((rule) => ({
			id: rule.id, area: rule.area, category: rule.category,
			severity: effective.rules[rule.id].severity, sourceKinds: [...rule.sourceKinds],
		}));
		const kinds = [...new Set(selected.flatMap((rule) => rule.sourceKinds)
			.filter((kind) => !scope.sourceKinds || scope.sourceKinds.includes(kind))
			.filter((kind) => {
				if (scope.mode !== 'partial' || scope.targetKeys?.length || scope.sourceKeys?.length) { return true; }
				if (scope.pairs?.length && !scope.files?.length) {
					return scope.pairs.some((pair) => pair.targetKey.includes('|' + kind + '|'));
				}
				if (!scope.files?.length) { return true; }
				if (kind === 'bsl') { return scope.files.some((uri) => filePath(uri)?.toLowerCase().endsWith('.bsl')); }
				if (kind === 'metadata') { return scope.files.some((uri) => /\.(xml|mdo)$/i.test(filePath(uri) ?? '')); }
				return true;
			}))].sort(compareText);
		if (kinds.length === 0) {
			const explicit = scope.mode === 'partial' && Boolean(scope.files?.length || scope.targetKeys?.length || scope.pairs?.length);
			return { ...result(scope, runId, key, explicit ? 'unsupported' : 'noApplicableRules',
				explicit ? [{ code: 'unsupportedSource', message: 'Нет поставщика для выбранной цели.', projectKey: key }] : []),
				selectedRules };
		}
		const inventoryEpoch = this.store.inventoryRevision(key);
		const projectEpoch = this.store.projectGeneration(key);
		const inventories = new Map<SourceKind, SourceInventory>();
		const sourceCompleteness: Partial<Record<SourceKind, boolean>> = {};
		const errors: CodeStyleError[] = [];
		let enumerateComplete = true, unsupported = false;
		for (const kind of kinds) {
			if (token.isCancellationRequested) { enumerateComplete = false; sourceCompleteness[kind] = false; break; }
			const provider = this.sources.get(kind);
			if (!provider) {
				unsupported = true; enumerateComplete = false; sourceCompleteness[kind] = false;
				errors.push({ code: 'unsupportedSourceKind', sourceKind: kind,
					message: 'Поставщик не зарегистрирован: ' + kind, projectKey: key });
				continue;
			}
			try {
				const directTargets = [...(scope.targetKeys ?? []), ...(scope.pairs ?? []).map((pair) => pair.targetKey)];
				const inventory = await provider.enumerate(project, {
					files: scope.mode === 'partial' ? scope.files : undefined,
					targetKeys: scope.mode === 'partial' && directTargets.length ? [...new Set(directTargets)] : undefined,
					sourceKeys: scope.sourceKeys,
				}, token);
				inventories.set(kind, inventory);
				sourceCompleteness[kind] = inventory.complete && inventory.errors.length === 0;
				errors.push(...inventory.errors.map((error) => ({ ...error, sourceKind: kind })));
				if (!sourceCompleteness[kind]) { enumerateComplete = false; }
			} catch (error) {
				enumerateComplete = false; sourceCompleteness[kind] = false;
				errors.push({ code: 'sourceEnumerateFailed', sourceKind: kind, message: String(error), projectKey: key });
				log.error('Перечисление ' + kind + ': ' + (error instanceof Error ? error.stack ?? error.message : error));
			}
		}
		const allTargets = [...inventories.values()].flatMap((entry) => entry.targets).sort(targetCompare);
		const missing = requestedErrors(scope, allTargets, key);
		errors.push(...missing);
		const pairs: PairResult[] = [];
		const checkedTargets = new Set<string>(), applicable = new Set<string>();
		const inventoryRevision = [...inventories.entries()]
			.map(([kind, entry]) => kind + ':' + entry.revision).sort(compareText).join('|');
		let acceptedCount = 0;
		let nextIndex = 0;

		const checkTarget = async (target: TargetDescriptor): Promise<void> => {
			if (token.isCancellationRequested) { return; }
			const rules = checkRules(target, selected, scope);
			if (rules.length === 0) { return; }
			const tickets = new Map<string, CommitTicket>();
			for (const rule of rules) {
				tickets.set(rule.id, this.store.ticket({
					runId, sequence, projectKey: key, ruleId: rule.id,
					area: rule.area, category: rule.category, severity: effective.rules[rule.id].severity,
					target, settingsRevision: effective.rules[rule.id].revision,
					sourceVersion: '', cancellation: token,
				}));
			}
			try {
				const provider = this.sources.get(target.sourceKind)!;
				const executed = await this.engine.checkTarget(project, target, provider, rules,
					effective.rules, token, (uri) => this.store.fileGeneration(uri));
				for (const pair of executed.pairs) {
					const original = tickets.get(pair.ruleId)!;
					if (pair.status !== 'skipped') {
						applicable.add(IssueStore.pairId(key, pair.ruleId, target.targetKey));
					}
					if (pair.status === 'skipped') {
						this.store.deactivatePair(original);
						pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey, status: 'skipped', issues: 0 });
						continue;
					}
					if (pair.status !== 'completed') {
						this.store.fail(original, pair.status, pair.error);
						pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey,
							status: pair.status, issues: 0, error: pair.error });
						if (pair.error) { errors.push({ ...pair.error, sourceKind: target.sourceKind }); }
						continue;
					}
					const accepted = await this.store.commit({ ...original, sourceVersion: pair.sourceVersion,
						dependencies: pair.dependencies }, pair.issues);
					pairs.push({ ruleId: pair.ruleId, targetKey: target.targetKey,
						status: accepted ? 'completed' : 'stale', issues: accepted ? pair.issues.length : 0 });
					if (accepted) { checkedTargets.add(target.targetKey); acceptedCount += pair.issues.length; }
				}
			} catch (error) {
				const technical: CodeStyleError = {
					code: 'targetCheckFailed', sourceKind: target.sourceKind, message: String(error),
					projectKey: key, targetKey: target.targetKey,
				};
				errors.push(technical);
				log.error('Проверка цели: ' + (error instanceof Error ? error.stack ?? error.message : error));
				for (const rule of rules) {
					const ticket = tickets.get(rule.id)!;
					applicable.add(IssueStore.pairId(key, rule.id, target.targetKey));
					this.store.fail(ticket, 'error', { ...technical, ruleId: rule.id });
					pairs.push({ ruleId: rule.id, targetKey: target.targetKey, status: 'error', issues: 0,
						error: { ...technical, ruleId: rule.id } });
				}
			}
		};
		const count = Math.min(effective.maxConcurrency, allTargets.length);
		await Promise.all(Array.from({ length: count }, async () => {
			while (!token.isCancellationRequested && nextIndex < allTargets.length) {
				const target = allTargets[nextIndex++];
				await checkTarget(target);
			}
		}));
		pairs.sort((a, b) => compareText(a.targetKey, b.targetKey) || compareText(a.ruleId, b.ruleId));

		let inventoryCurrent = this.store.inventoryRevision(key) === inventoryEpoch &&
			this.store.projectGeneration(key) === projectEpoch;
		if (scope.mode === 'full' && enumerateComplete && !token.isCancellationRequested && inventoryCurrent) {
			inventoryCurrent = this.store.reconcileFull({
				projectKey: key, projectGeneration: projectEpoch, inventoryGeneration: inventoryEpoch, sequence,
				ruleIds: selected.map((rule) => rule.id), kinds, sourceKeys: scope.sourceKeys, applicablePairs: applicable,
			});
		}
		if (!inventoryCurrent) {
			errors.push({ code: 'staleInventory', message: 'Состав источников изменился во время обхода.', projectKey: key });
		}
		const pairSuccessful = pairs.every((pair) => pair.status === 'completed' || pair.status === 'skipped');
		const allSkipped = pairs.every((pair) => pair.status === 'skipped');
		const finished = !token.isCancellationRequested && enumerateComplete && inventoryCurrent && missing.length === 0 &&
			errors.length === 0 && pairSuccessful;
		const staleOnly = !token.isCancellationRequested &&
			(!inventoryCurrent || pairs.some((pair) => pair.status === 'stale')) &&
			pairs.every((pair) => pair.status === 'stale' || pair.status === 'skipped') &&
			errors.every((error) => ['staleInventory', 'staleSource', 'dirtySource'].includes(error.code));
		let status: ScanResult['status'];
		if (token.isCancellationRequested) { status = 'cancelled'; }
		else if (staleOnly) { status = 'stale'; }
		else if (unsupported && inventories.size === 0) { status = 'unsupported'; }
		else if (missing.length > 0 && checkedTargets.size === 0) { status = 'unsupported'; }
		else if (pairs.length && pairs.every((pair) => pair.status === 'unsupported' || pair.status === 'skipped')) {
			status = 'unsupported';
		} else if (finished && allSkipped) { status = 'noApplicableRules'; }
		else if (finished) { status = 'completed'; }
		else if (checkedTargets.size > 0) { status = 'partial'; }
		else if (pairs.some((pair) => pair.status === 'stale')) { status = 'stale'; }
		else { status = 'error'; }
		return { runId, projectKey: key, requested: scope, selectedRules, sourceCompleteness,
			inventoryCurrent, inventoryEpoch, actualTargets: [...checkedTargets].sort(compareText), pairs,
			inventoryRevision, complete: finished, status, issues: acceptedCount, errors };
	}
}
