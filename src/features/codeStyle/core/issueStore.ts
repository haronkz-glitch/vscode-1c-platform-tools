import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { sameOrUnder } from '../../../shared/projectLayout';
import { canonicalFileUri, compareText } from './identity';
import { persistedVersion } from './sourceVersion';
import type {
	CodeStyleError, Issue, IssueFilter, IssueQueryResult, PairStatus, RuleArea, RuleCategory, Severity, ScanResult, SourceKind, StoreChange,
	TargetDescriptor,
} from './types';

export interface CommitTicket {
	readonly runId: string;
	readonly sequence: number;
	readonly projectKey: string;
	readonly ruleId: string;
	readonly area: RuleArea;
	readonly category: RuleCategory;
	readonly severity: Severity;
	readonly target: TargetDescriptor;
	readonly settingsRevision: string;
	readonly sourceVersion: string;
	readonly sourceGeneration: number;
	readonly projectGeneration: number;
	readonly dependencies: readonly { uri: string; version: string; generation: number }[];
	readonly cancellation: vscode.CancellationToken;
}
export interface AffectedPair {
	readonly projectKey: string;
	readonly ruleId: string;
	readonly targetKey: string;
	readonly targetUri: string;
	readonly sourceKind: SourceKind;
}
export interface PairState {
	readonly projectKey: string;
	readonly ruleId: string;
	readonly targetKey: string;
	readonly sourceKey: string;
	readonly area: RuleArea;
	readonly category: RuleCategory;
	readonly severity: Severity;
	readonly status: PairStatus;
	readonly stale: boolean;
	readonly error?: CodeStyleError;
}
interface StoredPair {
	readonly ticket: CommitTicket;
	readonly issues: readonly Issue[];
	readonly status: PairStatus;
	lastSequence: number;
	stale: boolean;
	error?: CodeStyleError;
}
const pairKey = (projectKey: string, ruleId: string, targetKey: string): string =>
	JSON.stringify([projectKey, ruleId, targetKey]);
const configKey = (projectKey: string, ruleId: string): string => JSON.stringify([projectKey, ruleId]);

const copyIssues = (issues: readonly Issue[]): Issue[] =>
	issues.map((issue) => ({
		...issue,
		location: { uri: issue.location.uri, range: { start: { ...issue.location.range.start }, end: { ...issue.location.range.end } } },
		relatedLocations: issue.relatedLocations?.map((related) => ({
			uri: related.uri, range: { start: { ...related.range.start }, end: { ...related.range.end } },
		})),
		fix: issue.fix ? { ...issue.fix } : undefined,
	}));

/** The only arbiter of snapshot versions, settings revisions, and pair ordering. */
export class IssueStore implements vscode.Disposable {
	private readonly pairs = new Map<string, StoredPair>();
	private readonly byUri = new Map<string, Set<string>>();
	private readonly generation = new Map<string, number>();
	private readonly projectEpoch = new Map<string, number>();
	private readonly inventoryEpoch = new Map<string, number>();
	private readonly settings = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<StoreChange>();
	private readonly scans = new Map<string, ScanResult>();
	private disposed = false;
	private revisionResolver?: (projectKey: string, ruleId: string) => string | undefined;

	readonly onDidChange = this.emitter.event;
	setRevisionResolver(resolve: (projectKey: string, ruleId: string) => string | undefined): void {
		this.revisionResolver = resolve;
	}
	private currentRevision(projectKey: string, ruleId: string): string | undefined {
		try { return this.revisionResolver?.(projectKey, ruleId); }
		catch { return undefined; }
	}
	fileGeneration(uri: string): number { return this.generation.get(canonicalFileUri(uri)) ?? 0; }
	projectGeneration(key: string): number { return this.projectEpoch.get(key) ?? 0; }
	inventoryRevision(key: string): number { return this.inventoryEpoch.get(key) ?? 0; }
	bumpInventory(key: string): void {
		if (!this.disposed) { this.inventoryEpoch.set(key, this.inventoryRevision(key) + 1); }
	}
	knownSourceVersion(uri: string): string | undefined {
		for (const id of this.byUri.get(canonicalFileUri(uri)) ?? []) {
			const pair = this.pairs.get(id);
			if (pair && pair.status === 'completed' && !pair.stale && canonicalFileUri(pair.ticket.target.uri) === canonicalFileUri(uri)) {
				return pair.ticket.sourceVersion;
			}
		}
		return undefined;
	}

	ticket(input: Omit<CommitTicket, 'sourceGeneration' | 'projectGeneration' | 'dependencies'> & {
		dependencies?: CommitTicket['dependencies'];
	}): CommitTicket {
		return {
			...input, sourceGeneration: this.fileGeneration(input.target.uri),
			projectGeneration: this.projectGeneration(input.projectKey), dependencies: input.dependencies ?? [],
		};
	}

	setRuleRevisions(projectKey: string, revisions: Readonly<Record<string, string>>): readonly string[] {
		const affected = new Set<string>(), uris = new Set<string>(), rules = new Set<string>();
		for (const [ruleId, revision] of Object.entries(revisions)) {
			const key = configKey(projectKey, ruleId);
			const previous = this.settings.get(key);
			// Older runs must not roll back the live configuration revision.
			if (this.revisionResolver && this.currentRevision(projectKey, ruleId) !== revision) { continue; }
			this.settings.set(key, revision);
			if (previous === undefined || previous === revision) { continue; }
			rules.add(ruleId);
			for (const [pairId, pair] of this.pairs) {
				if (pair.ticket.projectKey !== projectKey || pair.ticket.ruleId !== ruleId || pair.stale) { continue; }
				pair.stale = true;
				affected.add(pairId);
				for (const issue of pair.issues) { uris.add(issue.location.uri); }
			}
		}
		if (affected.size) { this.fire('settings', uris, [projectKey], rules); }
		return [...rules];
	}

	private isTicketCurrent(ticket: CommitTicket): boolean {
		if (this.disposed || ticket.cancellation.isCancellationRequested ||
			this.settings.get(configKey(ticket.projectKey, ticket.ruleId)) !== ticket.settingsRevision ||
			(this.revisionResolver !== undefined &&
				this.currentRevision(ticket.projectKey, ticket.ruleId) !== ticket.settingsRevision) ||
			this.projectGeneration(ticket.projectKey) !== ticket.projectGeneration ||
			this.fileGeneration(ticket.target.uri) !== ticket.sourceGeneration ||
			ticket.dependencies.some((dep) => this.fileGeneration(dep.uri) !== dep.generation)) {
			return false;
		}
		const previous = this.pairs.get(pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey));
		return !previous || previous.lastSequence <= ticket.sequence;
	}
	/** Verify files and symlink boundaries inside Store rather than trusting the planner. */
	private async verifyCurrentVersions(ticket: CommitTicket): Promise<boolean> {
		if (!ticket.sourceVersion) { return false; }
		const verify = async (uri: string, version: string, sourceRoot?: string): Promise<boolean> => {
			try {
				const parsed = vscode.Uri.parse(uri);
				if (parsed.scheme !== 'file' || !sameOrUnder(parsed.fsPath, ticket.projectKey) ||
					(sourceRoot && !sameOrUnder(parsed.fsPath, sourceRoot))) { return false; }
				const [realProject, realFile, realSource] = await Promise.all([
					fs.realpath(ticket.projectKey), fs.realpath(parsed.fsPath),
					sourceRoot ? fs.realpath(sourceRoot) : Promise.resolve(undefined),
				]);
				if (!sameOrUnder(realFile, realProject) ||
					(realSource && (!sameOrUnder(realSource, realProject) || !sameOrUnder(realFile, realSource)))) {
					return false;
				}
				return (await persistedVersion(uri)) === version;
			} catch { return false; }
		};
		if (!(await verify(ticket.target.uri, ticket.sourceVersion, ticket.target.sourceRoot))) { return false; }
		for (const dependency of ticket.dependencies) {
			if (!(await verify(dependency.uri, dependency.version))) { return false; }
		}
		return true;
	}
	private indexedUris(pair: StoredPair): Set<string> {
		return new Set([pair.ticket.target.uri, ...pair.ticket.dependencies.map((dep) => dep.uri),
			...pair.issues.flatMap((issue) => [issue.location.uri, ...(issue.relatedLocations ?? []).map((loc) => loc.uri)])
		].map(canonicalFileUri));
	}
	private reindex(key: string, previous?: StoredPair, next?: StoredPair): void {
		if (previous) {
			for (const uri of this.indexedUris(previous)) {
				const entries = this.byUri.get(uri);
				entries?.delete(key);
				if (entries?.size === 0) { this.byUri.delete(uri); }
			}
		}
		if (next) {
			for (const uri of this.indexedUris(next)) {
				const entries = this.byUri.get(uri) ?? new Set<string>();
				entries.add(key);
				this.byUri.set(uri, entries);
			}
		}
	}
	private fire(reason: StoreChange['reason'], uris: Iterable<string>, projects: Iterable<string>, rules: Iterable<string>): void {
		if (this.disposed) { return; }
		try {
			this.emitter.fire({ reason, uris: [...new Set(uris)], projectKeys: [...new Set(projects)], ruleIds: [...new Set(rules)] });
		} catch { /* Subscriber failures cannot roll back commits. */ }
	}
	async commit(ticket: CommitTicket, issues: readonly Issue[]): Promise<boolean> {
		if (!this.isTicketCurrent(ticket) || !(await this.verifyCurrentVersions(ticket)) ||
			!this.isTicketCurrent(ticket)) { return false; }
		const key = pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey);
		const previous = this.pairs.get(key);
		const next: StoredPair = { ticket, issues: copyIssues(issues), status: 'completed',
			lastSequence: ticket.sequence, stale: false };
		this.reindex(key, previous, next);
		this.pairs.set(key, next);
		this.fire('commit', [...(previous?.issues.map((issue) => issue.location.uri) ?? []),
			...next.issues.map((issue) => issue.location.uri)], [ticket.projectKey], [ticket.ruleId]);
		return true;
	}
	fail(ticket: CommitTicket, status: PairStatus, error?: CodeStyleError): boolean {
		if (!this.isTicketCurrent(ticket)) { return false; }
		const key = pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey);
		const previous = this.pairs.get(key);
		if (previous) {
			previous.error = error;
			previous.lastSequence = ticket.sequence;
			return true;
		}
		const next: StoredPair = { ticket, issues: [], status,
			lastSequence: ticket.sequence, stale: false, error };
		this.reindex(key, undefined, next);
		this.pairs.set(key, next);
		return true;
	}
	/** A previously applicable rule can become inapplicable without a successful check. */
	deactivatePair(ticket: CommitTicket): void {
		if (!this.isTicketCurrent(ticket)) { return; }
		const key = pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey);
		const previous = this.pairs.get(key);
		if (!previous || previous.stale) { return; }
		previous.stale = true;
		previous.lastSequence = ticket.sequence;
		this.fire('invalidate', previous.issues.map((issue) => issue.location.uri),
			[ticket.projectKey], [ticket.ruleId]);
	}
	/** Return affected target/rule pairs so the coordinator can reschedule dependencies. */
	invalidateUri(uri: string): readonly AffectedPair[] {
		if (this.disposed) { return []; }
		uri = canonicalFileUri(uri);
		this.generation.set(uri, this.fileGeneration(uri) + 1);
		const uris = new Set<string>(), projects = new Set<string>(), rules = new Set<string>();
		const affected: AffectedPair[] = [];
		for (const key of this.byUri.get(uri) ?? []) {
			const pair = this.pairs.get(key);
			if (!pair) { continue; }
			affected.push({
				projectKey: pair.ticket.projectKey, ruleId: pair.ticket.ruleId,
				targetKey: pair.ticket.target.targetKey, targetUri: canonicalFileUri(pair.ticket.target.uri),
				sourceKind: pair.ticket.target.sourceKind,
			});
			if (pair.stale) { continue; }
			pair.stale = true;
			projects.add(pair.ticket.projectKey);
			rules.add(pair.ticket.ruleId);
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
		}
		this.fire('invalidate', uris, projects, rules);
		return affected;
	}
	removeUri(uri: string): readonly AffectedPair[] {
		uri = canonicalFileUri(uri);
		const affected = this.invalidateUri(uri);
		const uris = new Set<string>(), projects = new Set<string>(), rules = new Set<string>();
		for (const key of [...(this.byUri.get(uri) ?? [])]) {
			const pair = this.pairs.get(key);
			if (!pair || canonicalFileUri(pair.ticket.target.uri) !== uri) { continue; }
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
			projects.add(pair.ticket.projectKey);
			rules.add(pair.ticket.ruleId);
			this.reindex(key, pair);
			this.pairs.delete(key);
		}
		this.fire('remove', uris, projects, rules);
		return affected.filter((pair) => canonicalFileUri(pair.targetUri) !== uri);
	}
	/** Confirmed directory removal: remove descendant targets and invalidate dependent pairs. */
	removeDirectory(directoryUri: string): readonly AffectedPair[] {
		const directory = vscode.Uri.parse(canonicalFileUri(directoryUri)).fsPath;
		const affected = new Map<string, AffectedPair>();
		for (const uri of [...this.byUri.keys()]) {
			if (!sameOrUnder(vscode.Uri.parse(uri).fsPath, directory)) { continue; }
			for (const pair of this.removeUri(uri)) {
				affected.set(pairKey(pair.projectKey, pair.ruleId, pair.targetKey), pair);
			}
		}
		return [...affected.values()];
	}

	invalidateProject(key: string, inventoryChanged = true): void {
		if (this.disposed) { return; }
		this.projectEpoch.set(key, this.projectGeneration(key) + 1);
		if (inventoryChanged) { this.bumpInventory(key); }
		const uris = new Set<string>(), rules = new Set<string>();
		for (const pair of this.pairs.values()) {
			if (pair.ticket.projectKey !== key || pair.stale) { continue; }
			pair.stale = true;
			rules.add(pair.ticket.ruleId);
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
		}
		this.fire('invalidate', uris, [key], rules);
	}
	removeProject(key: string): void {
		if (this.disposed) { return; }
		this.invalidateProject(key);
		const uris = new Set<string>(), rules = new Set<string>();
		for (const [id, pair] of [...this.pairs]) {
			if (pair.ticket.projectKey !== key) { continue; }
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
			rules.add(pair.ticket.ruleId);
			this.reindex(id, pair);
			this.pairs.delete(id);
		}
		for (const item of [...this.settings.keys()]) {
			if (JSON.parse(item)[0] === key) { this.settings.delete(item); }
		}
		this.fire('remove', uris, [key], rules);
	}
	/** Prune only an unchanged, complete inventory of selected rules/source kinds. */
	reconcileFull(input: {
		projectKey: string;
		inventoryGeneration: number;
		projectGeneration: number;
		sequence: number;
		ruleIds: readonly string[];
		kinds: readonly SourceKind[];
		sourceKeys?: readonly string[];
		applicablePairs: ReadonlySet<string>;
	}): boolean {
		if (this.disposed || this.inventoryRevision(input.projectKey) !== input.inventoryGeneration ||
			this.projectGeneration(input.projectKey) !== input.projectGeneration) { return false; }
		const uris = new Set<string>(), rules = new Set<string>();
		for (const [key, pair] of [...this.pairs]) {
			if (pair.ticket.projectKey !== input.projectKey ||
				!input.ruleIds.includes(pair.ticket.ruleId) ||
				!input.kinds.includes(pair.ticket.target.sourceKind) ||
				(input.sourceKeys && !input.sourceKeys.includes(pair.ticket.target.sourceKey)) ||
				input.applicablePairs.has(key) || pair.lastSequence > input.sequence) { continue; }
			this.reindex(key, pair);
			this.pairs.delete(key);
			rules.add(pair.ticket.ruleId);
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
		}
		if (rules.size) { this.fire('remove', uris, [input.projectKey], rules); }
		return true;
	}
	static pairId(projectKey: string, ruleId: string, targetKey: string): string {
		return pairKey(projectKey, ruleId, targetKey);
	}
	recordScan(scan: ScanResult): void {
		if (this.disposed) { return; }
		this.scans.set(scan.runId, JSON.parse(JSON.stringify(scan)) as ScanResult);
		if (this.scans.size > 100) { this.scans.delete(this.scans.keys().next().value!); }
	}
	getIssues(filter: IssueFilter = {}): readonly Issue[] {
		const found: Issue[] = [];
		for (const pair of this.pairs.values()) {
			if (pair.status !== 'completed') { continue; }
			if (filter.status !== 'all' && filter.status !== 'stale' && pair.stale) { continue; }
			if (filter.status === 'stale' && !pair.stale) { continue; }
			if (filter.projectKey && pair.ticket.projectKey !== filter.projectKey) { continue; }
			if (filter.targetKey && pair.ticket.target.targetKey !== filter.targetKey) { continue; }
			if (filter.area && pair.ticket.area !== filter.area) { continue; }
			if (filter.category && pair.ticket.category !== filter.category) { continue; }
			if (filter.severity && pair.ticket.severity !== filter.severity) { continue; }
			if (filter.sourceKey && pair.ticket.target.sourceKey !== filter.sourceKey) { continue; }
			if (filter.ruleId && pair.ticket.ruleId !== filter.ruleId) { continue; }
			for (const issue of pair.issues) {
				if ((filter.uri && canonicalFileUri(issue.location.uri) !== canonicalFileUri(filter.uri)) ||
					(filter.area && issue.area !== filter.area) ||
					(filter.category && issue.category !== filter.category) ||
					(filter.severity && issue.severity !== filter.severity)) { continue; }
				found.push(issue);
			}
		}
		found.sort((a, b) => compareText(a.projectKey, b.projectKey) ||
			compareText(a.location.uri, b.location.uri) ||
			a.location.range.start.line - b.location.range.start.line ||
			a.location.range.start.character - b.location.range.start.character ||
			compareText(a.ruleId, b.ruleId) || compareText(a.id, b.id));
		return copyIssues(found);
	}
	getPairStates(filter: IssueFilter = {}): readonly PairState[] {
		return [...this.pairs.values()].filter((pair) =>
			(!filter.projectKey || filter.projectKey === pair.ticket.projectKey) &&
			(!filter.sourceKey || filter.sourceKey === pair.ticket.target.sourceKey) &&
			(!filter.targetKey || filter.targetKey === pair.ticket.target.targetKey) &&
			(!filter.ruleId || filter.ruleId === pair.ticket.ruleId) &&
			(!filter.status || filter.status === 'all' ||
				(filter.status === 'stale' ? pair.stale : !pair.stale)) &&
			(!filter.area || filter.area === pair.ticket.area) &&
			(!filter.category || filter.category === pair.ticket.category) &&
			(!filter.severity || filter.severity === pair.ticket.severity) &&
			(!filter.uri || this.indexedUris(pair).has(canonicalFileUri(filter.uri)))
		).map((pair) => ({
			projectKey: pair.ticket.projectKey, ruleId: pair.ticket.ruleId,
			targetKey: pair.ticket.target.targetKey, sourceKey: pair.ticket.target.sourceKey,
			area: pair.ticket.area, category: pair.ticket.category, severity: pair.ticket.severity,
			status: pair.status, stale: pair.stale,
			error: pair.error ? { ...pair.error } : undefined,
		})).sort((a, b) => compareText(a.projectKey, b.projectKey) ||
			compareText(a.targetKey, b.targetKey) || compareText(a.ruleId, b.ruleId));
	}
	query(filter: IssueFilter = {}): IssueQueryResult {
		const ruleMatches = (rule: NonNullable<ScanResult['selectedRules']>[number]): boolean =>
			(!filter.ruleId || rule.id === filter.ruleId) &&
			(!filter.area || rule.area === filter.area) &&
			(!filter.category || rule.category === filter.category) &&
			(!filter.severity || rule.severity === filter.severity);
		const scoped = (scan: ScanResult): boolean => {
			if (filter.projectKey && scan.projectKey !== filter.projectKey) { return false; }
			if (filter.sourceKey &&
				(!scan.inventorySources?.includes(filter.sourceKey) ||
					(scan.requested.sourceKeys && !scan.requested.sourceKeys.includes(filter.sourceKey)))) { return false; }
			if (scan.status === 'noApplicableRules' && filter.ruleId) {
				return scan.requested.ruleIds?.includes(filter.ruleId) === true;
			}
			// A full scan restricted to one source must never certify another source.
			if (scan.requested.sourceKeys?.length &&
				(!filter.sourceKey || !scan.requested.sourceKeys.includes(filter.sourceKey))) { return false; }
			if (filter.ruleId || filter.area || filter.category || filter.severity) {
				return scan.selectedRules?.some(ruleMatches) === true;
			}
			return true;
		};
		const order = (scan: ScanResult): number => Number(scan.runId.split('-').at(-1)) || 0;
		const recent = [...this.scans.values()].filter(scoped).sort((a, b) => order(b) - order(a));
		const full = new Map<string, ScanResult>();
		for (const scan of recent) {
			if (scan.requested.mode === 'full' && !full.has(scan.projectKey) &&
				(!scan.requested.ruleIds?.length || Boolean(filter.ruleId &&
					scan.requested.ruleIds.includes(filter.ruleId))) &&
				(!scan.requested.sourceKinds?.length || Boolean(filter.sourceKey || filter.ruleId))) {
				full.set(scan.projectKey, scan);
			}
		}
		// Keep the latest attempt as well as the full inventory baseline.
		const scans = recent.filter((scan) =>
			scan === full.get(scan.projectKey) ||
				!recent.some((other) => other.projectKey === scan.projectKey && order(other) > order(scan))
		).map((scan) => JSON.parse(JSON.stringify(scan)) as ScanResult);
		const states = this.getPairStates(filter);
		const errors: CodeStyleError[] = [...states.flatMap((state) => state.error ? [state.error] : [])];
		const scanErrors = (scan: ScanResult): CodeStyleError[] => {
			const rules = (scan.selectedRules ?? []).filter(ruleMatches);
			const ruleIds = new Set(rules.map((rule) => rule.id));
			const kinds = new Set(rules.flatMap((rule) => rule.sourceKinds));
			return scan.errors.filter((error) => {
				if (filter.sourceKey && error.sourceKey && error.sourceKey !== filter.sourceKey) { return false; }
				if (filter.targetKey && error.targetKey && error.targetKey !== filter.targetKey) { return false; }
				if (filter.ruleId && error.ruleId && error.ruleId !== filter.ruleId) { return false; }
				if (error.ruleId && !ruleIds.has(error.ruleId)) { return false; }
				if (error.sourceKind && !kinds.has(error.sourceKind)) { return false; }
				return !(filter.ruleId || filter.area || filter.category || filter.severity) ||
					Boolean(error.ruleId || error.sourceKind);
			});
		};
		for (const scan of scans) { errors.push(...scanErrors(scan)); }
		const projects = new Set([...scans.map((scan) => scan.projectKey), ...states.map((state) => state.projectKey)]);
		const narrow = Boolean(filter.ruleId || filter.area || filter.category || filter.severity);
		const scopeComplete = (scan: ScanResult): boolean => {
			const relevant = (scan.selectedRules ?? []).filter(ruleMatches);
			if (relevant.some((rule) =>
				this.settings.get(configKey(scan.projectKey, rule.id)) !== scan.ruleRevisions?.[rule.id] ||
				(this.revisionResolver !== undefined &&
					this.currentRevision(scan.projectKey, rule.id) !== scan.ruleRevisions?.[rule.id]))) { return false; }
			if (scan.status === 'noApplicableRules') { return scan.complete && !narrow; }
			if (scan.inventoryCurrent !== true || scan.requested.mode !== 'full' ||
				(scan.inventoryEpoch !== undefined && this.inventoryRevision(scan.projectKey) !== scan.inventoryEpoch) ||
				(scan.requested.sourceKeys?.length && (!filter.sourceKey ||
					!scan.requested.sourceKeys.includes(filter.sourceKey)))) { return false; }
			// A scan of A cannot certify that all other rules/categories were checked.
			if (scan.requested.ruleIds?.length && !filter.ruleId) { return false; }
			if (scan.requested.sourceKinds?.length && !filter.ruleId) { return false; }
			if (!narrow) { return scan.complete; }
			const rules = (scan.selectedRules ?? []).filter(ruleMatches);
			const kinds = new Set(rules.flatMap((rule) => rule.sourceKinds));
			return rules.length > 0 && [...kinds].every((kind) => scan.sourceCompleteness?.[kind] === true) &&
				scanErrors(scan).length === 0 &&
				scan.pairs.filter((pair) => rules.some((rule) => rule.id === pair.ruleId))
					.every((pair) => pair.status === 'completed' || pair.status === 'skipped');
		};
		const complete = errors.length === 0 && projects.size > 0 && [...projects].every((projectKey) => {
			const matching = states.filter((state) => state.projectKey === projectKey);
			if (matching.some((state) => state.status !== 'completed' || state.stale || state.error)) { return false; }
			if (filter.targetKey || filter.uri) { return matching.length > 0; }
			const covering = full.get(projectKey);
			if (covering) { return scopeComplete(covering); }
			return scans.some((scan) => scan.projectKey === projectKey && !narrow &&
				scan.status === 'noApplicableRules' && scan.complete);
		});
		return { issues: this.getIssues(filter), scans, pairStates: states, errors, complete };
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.pairs.clear(); this.byUri.clear(); this.generation.clear(); this.projectEpoch.clear();
		this.inventoryEpoch.clear(); this.settings.clear(); this.scans.clear(); this.emitter.dispose();
	}
}
