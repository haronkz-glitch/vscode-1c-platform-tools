import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { projectKeyOf } from './identity';
import type { ScanPair, ScanResult, ScanScope, SourceKind } from './types';
import { ScanPlanner } from './scanPlanner';
import { RuleRegistry } from './ruleRegistry';
import { IssueStore } from './issueStore';

const log = logger.scope('code-style');
/** Jobs across projects are bounded separately from the per-project target concurrency. */
const MAX_ACTIVE_PROJECTS = 2;
interface Job {
	scope: ScanScope;
	readonly sequence: number;
	readonly runId: string;
	readonly background: boolean;
	readonly source: vscode.CancellationTokenSource;
	readonly resolve: (result: ScanResult) => void;
	readonly completion: Promise<ScanResult>;
}
interface Pending {
	scope: ScanScope;
	timer?: NodeJS.Timeout;
}
function union(left?: readonly string[], right?: readonly string[]): readonly string[] | undefined {
	return left && right ? [...new Set([...left, ...right])] : undefined;
}
function mergeScopes(left: ScanScope, right: ScanScope): ScanScope {
	const full = left.mode === 'full' || right.mode === 'full';
	const sources = union(left.sourceKeys, right.sourceKeys);
	const fullGlobal = full && (
		(left.mode === 'full' && !left.sourceKeys) || (right.mode === 'full' && !right.sourceKeys) ||
		(left.mode === 'partial' && (left.files?.length || left.targetKeys?.length || left.pairs?.length)) ||
		(right.mode === 'partial' && (right.files?.length || right.targetKeys?.length || right.pairs?.length))
	);
	const pairs = new Map<string, ScanPair>();
	for (const pair of [...(left.pairs ?? []), ...(right.pairs ?? [])]) {
		pairs.set(JSON.stringify([pair.ruleId, pair.targetKey]), pair);
	}
	const leftDirect = left.mode === 'full' || !!left.files?.length || !!left.targetKeys?.length || !left.pairs?.length;
	const rightDirect = right.mode === 'full' || !!right.files?.length || !!right.targetKeys?.length || !right.pairs?.length;
	return {
		projectRoot: left.projectRoot, mode: full ? 'full' : 'partial',
		sourceKeys: fullGlobal ? undefined : sources,
		sourceKinds: union(left.sourceKinds, right.sourceKinds),
		ruleIds: leftDirect && rightDirect ? union(left.ruleIds, right.ruleIds) :
			leftDirect ? left.ruleIds : rightDirect ? right.ruleIds : undefined,
		files: full ? undefined : [...new Set([...(left.files ?? []), ...(right.files ?? [])])],
		targetKeys: full ? undefined : [...new Set([...(left.targetKeys ?? []), ...(right.targetKeys ?? [])])],
		pairs: full ? undefined : [...pairs.values()],
	};
}
function domain(scope: ScanScope): string {
	return scope.mode === 'full' && scope.sourceKeys?.length === 1
		? 'source:' + scope.sourceKeys[0] : 'project';
}
/** Debounced background scheduling with bounded multi-project execution. */
export class ScanScheduler implements vscode.Disposable {
	private readonly queue: Job[] = [];
	private readonly running = new Set<Job>();
	private readonly pending = new Map<string, Pending>();
	private readonly changed = new vscode.EventEmitter<ScanResult>();
	private sequence = 0;
	private disposed = false;
	readonly onDidChangeScanState = this.changed.event;

	constructor(
		private readonly planner: ScanPlanner,
		private readonly registry: RuleRegistry,
		private readonly store: IssueStore
	) {}
	private shortResult(scope: ScanScope, status: ScanResult['status'], runId?: string): ScanResult {
		return { requested: scope, runId: runId ?? 'code-style-' + (++this.sequence),
			projectKey: projectKeyOf(scope.projectRoot), actualTargets: [], pairs: [],
			complete: status === 'noApplicableRules', status, issues: 0, errors: [] };
	}
	private publish(result: ScanResult): void {
		if (this.disposed) { return; }
		this.store.recordScan(result);
		try { this.changed.fire(result); }
		catch (error) { log.warn('Подписчик сканирования: ' + String(error)); }
	}
	run(scope: ScanScope): Promise<ScanResult> { return this.enqueue(scope, false); }
	private enqueue(scope: ScanScope, background: boolean): Promise<ScanResult> {
		if (this.disposed) { return Promise.resolve(this.shortResult(scope, 'cancelled')); }
		if (this.registry.list().length === 0) {
			const empty = this.shortResult(scope, 'noApplicableRules');
			this.publish(empty);
			return Promise.resolve(empty);
		}
		if (background) {
			const waiting = this.queue.find((job) => job.background && !job.source.token.isCancellationRequested &&
				projectKeyOf(job.scope.projectRoot) === projectKeyOf(scope.projectRoot) &&
				domain(job.scope) === domain(scope));
			if (waiting) {
				waiting.scope = mergeScopes(waiting.scope, scope);
				return waiting.completion;
			}
		}
		if (!background && this.queue.filter((job) => !job.background).length >= 16) {
			const busy = { ...this.shortResult(scope, 'error'),
				errors: [{ code: 'scanQueueFull', message: 'Очередь явных проверок переполнена.' }] };
			this.publish(busy);
			return Promise.resolve(busy);
		}
		let settle!: (result: ScanResult) => void;
		const completion = new Promise<ScanResult>((resolve) => { settle = resolve; });
		const sequence = ++this.sequence;
		this.queue.push({ scope, sequence, runId: 'code-style-' + sequence, background,
			source: new vscode.CancellationTokenSource(), resolve: settle, completion });
		this.pump();
		return completion;
	}
	private pump(): void {
		if (this.disposed) { return; }
		while (this.running.size < MAX_ACTIVE_PROJECTS) {
			const index = this.queue.findIndex((job) =>
				![...this.running].some((running) =>
					projectKeyOf(running.scope.projectRoot) === projectKeyOf(job.scope.projectRoot)));
			if (index < 0) { return; }
			const [job] = this.queue.splice(index, 1);
			this.running.add(job);
			void this.planner.scan(job.scope, job.runId, job.sequence, job.source.token)
				.catch((error: unknown): ScanResult => {
					log.error('Планирование: ' + (error instanceof Error ? error.stack ?? error.message : error));
					return { ...this.shortResult(job.scope, 'error', job.runId),
						errors: [{ code: 'scanFailed', message: String(error) }] };
				})
				.then((result) => {
					this.publish(result);
					job.resolve(result);
				})
				.finally(() => {
					this.running.delete(job);
					job.source.dispose();
					this.pump();
				});
		}
	}
	private scheduleScope(scope: ScanScope): void {
		if (this.disposed || this.registry.list().length === 0) { return; }
		const key = JSON.stringify([projectKeyOf(scope.projectRoot), domain(scope)]);
		const pending = this.pending.get(key);
		if (pending) {
			pending.scope = mergeScopes(pending.scope, scope);
			if (pending.timer) { clearTimeout(pending.timer); }
		}
		const entry: Pending = pending ?? { scope };
		entry.timer = setTimeout(() => {
			this.pending.delete(key);
			void this.enqueue(entry.scope, true);
		}, 300);
		this.pending.set(key, entry);
	}
	schedule(root: string, uri?: string, ruleIds?: readonly string[], sourceKinds?: readonly SourceKind[]): void {
		this.scheduleScope({ projectRoot: root, mode: uri ? 'partial' : 'full',
			files: uri ? [uri] : undefined, ruleIds, sourceKinds });
	}
	/** Re-enumerate only one source; full cleanup is restricted to that sourceKey. */
	scheduleSource(root: string, sourceKey: string, kind: SourceKind): void {
		this.scheduleScope({ projectRoot: root, mode: 'full', sourceKeys: [sourceKey], sourceKinds: [kind] });
	}
	/** Keep exact dependency pairs instead of forming ruleIds × targetKeys. */
	schedulePairs(root: string, pairs: readonly ScanPair[]): void {
		if (!pairs.length) { return; }
		this.scheduleScope({ projectRoot: root, mode: 'partial', pairs });
	}
	private cancelQueued(matches: (job: Job) => boolean): void {
		for (let i = this.queue.length - 1; i >= 0; i--) {
			const job = this.queue[i];
			if (!matches(job)) { continue; }
			this.queue.splice(i, 1);
			job.source.cancel();
			const result = this.shortResult(job.scope, 'cancelled', job.runId);
			this.publish(result);
			job.resolve(result);
			job.source.dispose();
		}
	}
	cancelForFile(uri: string): void {
		// Mixed scopes must keep independent work; IssueStore invalidates only affected pairs.
		const matches = (job: Job): boolean => job.scope.mode === 'partial' &&
			job.scope.files?.length === 1 && job.scope.files[0] === uri &&
			!job.scope.targetKeys?.length && !job.scope.pairs?.length;
		this.cancelQueued(matches);
		for (const job of this.running) { if (matches(job)) { job.source.cancel(); } }
		this.pump();
	}
	cancelProject(projectKey: string): void {
		for (const [key, pending] of this.pending) {
			if ((JSON.parse(key) as string[])[0] !== projectKey) { continue; }
			if (pending.timer) { clearTimeout(pending.timer); }
			this.pending.delete(key);
		}
		const matches = (job: Job): boolean => projectKeyOf(job.scope.projectRoot) === projectKey;
		this.cancelQueued(matches);
		for (const job of this.running) { if (matches(job)) { job.source.cancel(); } }
		this.pump();
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const pending of this.pending.values()) {
			if (pending.timer) { clearTimeout(pending.timer); }
		}
		this.pending.clear();
		for (const job of this.queue) {
			job.source.cancel();
			job.resolve(this.shortResult(job.scope, 'cancelled', job.runId));
			job.source.dispose();
		}
		this.queue.length = 0;
		for (const job of this.running) { job.source.cancel(); }
		this.changed.dispose();
	}
}
