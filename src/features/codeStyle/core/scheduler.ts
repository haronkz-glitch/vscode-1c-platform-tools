import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { projectKeyOf } from './identity';
import type { ScanResult, ScanScope, SourceKind } from './types';
import { ScanPlanner } from './scanPlanner';
import { RuleRegistry } from './ruleRegistry';
import { IssueStore } from './issueStore';

const log = logger.scope('code-style');
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
	readonly root: string;
	scope: ScanScope;
	timer?: NodeJS.Timeout;
}
function combined(left: readonly string[] | undefined, right: readonly string[] | undefined): readonly string[] | undefined {
	return left && right ? [...new Set([...left, ...right])] : undefined;
}
function mergeScopes(left: ScanScope, right: ScanScope): ScanScope {
	const full = left.mode === 'full' || right.mode === 'full';
	return {
		projectRoot: left.projectRoot,
		mode: full ? 'full' : 'partial',
		files: full ? undefined : [...new Set([...(left.files ?? []), ...(right.files ?? [])])],
		targetKeys: full ? undefined : [...new Set([...(left.targetKeys ?? []), ...(right.targetKeys ?? [])])],
		ruleIds: combined(left.ruleIds, right.ruleIds),
		sourceKinds: combined(left.sourceKinds, right.sourceKinds),
	};
}

/** One pending/queued background job per project, with independent debounce timers. */
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
		// Coalesce repeated background scopes even after an earlier debounce flush.
		if (background) {
			const waiting = this.queue.find((job) => job.background && !job.source.token.isCancellationRequested &&
				projectKeyOf(job.scope.projectRoot) === projectKeyOf(scope.projectRoot));
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
	private concurrency(): number {
		const root = this.queue[0]?.scope.projectRoot ?? this.running.values().next().value?.scope.projectRoot;
		if (!root) { return 2; }
		const n = vscode.workspace.getConfiguration('1c-platform-tools', vscode.Uri.file(root))
			.get<number>('codeStyle.maxConcurrency', 2);
		return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2;
	}
	private pump(): void {
		if (this.disposed) { return; }
		while (this.queue.length > 0 && this.running.size < this.concurrency()) {
			const job = this.queue.shift()!;
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
		const key = projectKeyOf(scope.projectRoot);
		const pending = this.pending.get(key);
		if (pending) {
			pending.scope = mergeScopes(pending.scope, scope);
			if (pending.timer) { clearTimeout(pending.timer); }
		}
		const entry = pending ?? { root: scope.projectRoot, scope };
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
	scheduleTargets(root: string, keys: readonly string[], ruleIds?: readonly string[]): void {
		if (keys.length === 0) { return; }
		this.scheduleScope({ projectRoot: root, mode: 'partial', targetKeys: keys, ruleIds });
	}
	cancelForFile(uri: string): void {
		for (const job of [...this.queue, ...this.running]) {
			if (job.scope.mode === 'partial' && job.scope.files?.includes(uri)) { job.source.cancel(); }
		}
	}
	cancelProject(projectKey: string): void {
		const pending = this.pending.get(projectKey);
		if (pending?.timer) { clearTimeout(pending.timer); }
		this.pending.delete(projectKey);
		for (const job of [...this.queue, ...this.running]) {
			if (projectKeyOf(job.scope.projectRoot) === projectKey) { job.source.cancel(); }
		}
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
