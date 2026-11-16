import * as vscode from 'vscode';
import { compareText } from './identity';
import type {
	CodeStyleError, Issue, IssueFilter, IssueQueryResult, PairStatus, ScanResult, SourceKind, StoreChange,
	TargetDescriptor,
} from './types';

export interface CommitTicket {
	readonly runId: string;
	readonly sequence: number;
	readonly projectKey: string;
	readonly ruleId: string;
	readonly target: TargetDescriptor;
	readonly settingsRevision: string;
	readonly sourceVersion: string;
	readonly sourceGeneration: number;
	readonly projectGeneration: number;
	readonly dependencies: readonly { uri: string; version: string; generation: number }[];
	readonly cancellation: vscode.CancellationToken;
}
interface StoredPair {
	readonly ticket: CommitTicket;
	readonly issues: readonly Issue[];
	readonly status: PairStatus;
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

/** Single arbiter of freshness, replacing pairs atomically and indexing every affected URI. */
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

	readonly onDidChange = this.emitter.event;

	fileGeneration(uri: string): number { return this.generation.get(uri) ?? 0; }
	/** Used to suppress duplicate watcher/save events for the already-checked version. */
	knownSourceVersion(uri: string): string | undefined {
		for (const id of this.byUri.get(uri) ?? []) {
			const pair = this.pairs.get(id);
			if (pair && !pair.stale && pair.ticket.target.uri === uri) { return pair.ticket.sourceVersion; }
		}
		return undefined;
	}
	projectGeneration(key: string): number { return this.projectEpoch.get(key) ?? 0; }
	inventoryRevision(key: string): number { return this.inventoryEpoch.get(key) ?? 0; }
	bumpInventory(key: string): void {
		if (!this.disposed) { this.inventoryEpoch.set(key, this.inventoryRevision(key) + 1); }
	}

	ticket(input: Omit<CommitTicket, 'sourceGeneration' | 'projectGeneration' | 'dependencies'> & {
		dependencies?: CommitTicket['dependencies'];
	}): CommitTicket {
		return {
			...input, sourceGeneration: this.fileGeneration(input.target.uri),
			projectGeneration: this.projectGeneration(input.projectKey), dependencies: input.dependencies ?? [],
		};
	}

	/** Called only for selected rules in a specific project; unrelated revisions remain untouched. */
	setRuleRevisions(projectKey: string, revisions: Readonly<Record<string, string>>): readonly string[] {
		const affected = new Set<string>();
		const uris = new Set<string>();
		const rules = new Set<string>();
		for (const [ruleId, revision] of Object.entries(revisions)) {
			const key = configKey(projectKey, ruleId);
			const previous = this.settings.get(key);
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
			this.projectGeneration(ticket.projectKey) !== ticket.projectGeneration ||
			this.fileGeneration(ticket.target.uri) !== ticket.sourceGeneration ||
			ticket.dependencies.some((dep) => this.fileGeneration(dep.uri) !== dep.generation)) {
			return false;
		}
		const previous = this.pairs.get(pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey));
		return !previous || previous.ticket.sequence <= ticket.sequence;
	}
	private indexedUris(pair: StoredPair): Set<string> {
		return new Set([pair.ticket.target.uri, ...pair.ticket.dependencies.map((dep) => dep.uri),
			...pair.issues.flatMap((issue) => [issue.location.uri, ...(issue.relatedLocations ?? []).map((location) => location.uri)])]);
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
		if (!this.disposed) {
			try { this.emitter.fire({ reason, uris: [...new Set(uris)], projectKeys: [...new Set(projects)], ruleIds: [...new Set(rules)] }); }
			catch { /* A subscriber cannot roll back an accepted commit. */ }
		}
	}
	commit(ticket: CommitTicket, issues: readonly Issue[]): boolean {
		if (!this.isTicketCurrent(ticket)) { return false; }
		const key = pairKey(ticket.projectKey, ticket.ruleId, ticket.target.targetKey);
		const previous = this.pairs.get(key);
		const next: StoredPair = { ticket, issues: copyIssues(issues), status: 'completed', stale: false };
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
			// Failure does not replace an earlier success with an empty result.
			previous.error = error;
		}
		return true;
	}
	/** Invalidate target, related source and diagnostic-location references immediately. */
	invalidateUri(uri: string): void {
		if (this.disposed) { return; }
		this.generation.set(uri, this.fileGeneration(uri) + 1);
		const uris = new Set<string>();
		const projects = new Set<string>();
		const rules = new Set<string>();
		for (const key of this.byUri.get(uri) ?? []) {
			const pair = this.pairs.get(key);
			if (!pair || pair.stale) { continue; }
			pair.stale = true;
			projects.add(pair.ticket.projectKey);
			rules.add(pair.ticket.ruleId);
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
		}
		this.fire('invalidate', uris, projects, rules);
	}
	/** Deletion is confirmed by the caller; affected dependency results become stale. */
	removeUri(uri: string): void {
		this.invalidateUri(uri);
		const uris = new Set<string>();
		const projects = new Set<string>();
		const rules = new Set<string>();
		for (const key of [...(this.byUri.get(uri) ?? [])]) {
			const pair = this.pairs.get(key);
			if (!pair || pair.ticket.target.uri !== uri) { continue; }
			for (const issue of pair.issues) { uris.add(issue.location.uri); }
			projects.add(pair.ticket.projectKey);
			rules.add(pair.ticket.ruleId);
			this.reindex(key, pair);
			this.pairs.delete(key);
		}
		this.fire('remove', uris, projects, rules);
	}
	invalidateProject(key: string, inventoryChanged = true): void {
		this.projectEpoch.set(key, this.projectGeneration(key) + 1);
		if (inventoryChanged) { this.inventoryEpoch.set(key, this.inventoryRevision(key) + 1); }
		const uris = new Set<string>();
		const rules = new Set<string>();
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
		const uris = new Set<string>();
		const rules = new Set<string>();
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
	/** Prune only a complete, unchanged full inventory and only selected rule/kind pairs. */
	reconcileFull(input: {
		projectKey: string;
		inventoryGeneration: number;
		projectGeneration: number;
		sequence: number;
		ruleIds: readonly string[];
		kinds: readonly SourceKind[];
		applicablePairs: ReadonlySet<string>;
	}): boolean {
		if (this.disposed || this.inventoryRevision(input.projectKey) !== input.inventoryGeneration ||
			this.projectGeneration(input.projectKey) !== input.projectGeneration) { return false; }
		const uris = new Set<string>(), rules = new Set<string>();
		for (const [key, pair] of [...this.pairs]) {
			if (pair.ticket.projectKey !== input.projectKey ||
				!input.ruleIds.includes(pair.ticket.ruleId) ||
				!input.kinds.includes(pair.ticket.target.sourceKind) ||
				input.applicablePairs.has(key) || pair.ticket.sequence > input.sequence) { continue; }
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
		this.scans.set(scan.runId, scan);
		if (this.scans.size > 40) { this.scans.delete(this.scans.keys().next().value!); }
	}
	getIssues(filter: IssueFilter = {}): readonly Issue[] {
		const found: Issue[] = [];
		for (const pair of this.pairs.values()) {
			if (filter.status !== 'all' && filter.status !== 'stale' && pair.stale) { continue; }
			if (filter.status === 'stale' && !pair.stale) { continue; }
			if (filter.projectKey && pair.ticket.projectKey !== filter.projectKey) { continue; }
			if (filter.targetKey && pair.ticket.target.targetKey !== filter.targetKey) { continue; }
			if (filter.sourceKey && pair.ticket.target.sourceKey !== filter.sourceKey) { continue; }
			if (filter.ruleId && pair.ticket.ruleId !== filter.ruleId) { continue; }
			for (const issue of pair.issues) {
				if ((filter.uri && issue.location.uri !== filter.uri) ||
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
	query(filter: IssueFilter = {}): IssueQueryResult {
		// Current status is the last result of each project, not a conjunction of historic failures.
		const latest = new Map<string, ScanResult>();
		for (const scan of this.scans.values()) {
			if (!filter.projectKey || scan.projectKey === filter.projectKey) { latest.set(scan.projectKey, scan); }
		}
		const scans = [...latest.values()];
		return { issues: this.getIssues(filter), scans, errors: scans.flatMap((scan) => scan.errors),
			complete: scans.length > 0 && scans.every((scan) => scan.complete) };
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.pairs.clear(); this.byUri.clear(); this.generation.clear(); this.projectEpoch.clear();
		this.inventoryEpoch.clear(); this.settings.clear(); this.scans.clear(); this.emitter.dispose();
	}
}
