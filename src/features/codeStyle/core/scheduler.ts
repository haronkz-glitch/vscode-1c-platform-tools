import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { projectKeyOf } from './identity';
import type { ScanResult, ScanScope } from './types';
import { ScanPlanner } from './scanPlanner';
import { RuleRegistry } from './ruleRegistry';

const log = logger.scope('code-style');

interface Job {
	readonly scope: ScanScope;
	readonly sequence: number;
	readonly runId: string;
	readonly source: vscode.CancellationTokenSource;
	readonly resolve: (result: ScanResult) => void;
}
interface Pending {
	readonly root: string;
	mode: 'full' | 'partial';
	files: Set<string>;
	ruleIds?: Set<string>;
}

/** A bounded queue with one debounce timer, shared by all rules and sources. */
export class ScanScheduler implements vscode.Disposable {
	private readonly queue: Job[] = [];
	private readonly running = new Set<Job>();
	private readonly pending = new Map<string, Pending>();
	private readonly changed = new vscode.EventEmitter<ScanResult>();
	private readonly registry: RuleRegistry;
	private timer: NodeJS.Timeout | undefined;
	private sequence = 0;
	private disposed = false;

	readonly onDidChangeScanState = this.changed.event;

	constructor(private readonly planner: ScanPlanner, registry: RuleRegistry) {
		this.registry = registry;
	}
	private noRules(scope: ScanScope, status: ScanResult['status']): ScanResult {
		return { requested: scope, runId: `code-style-${++this.sequence}`, projectKey: projectKeyOf(scope.projectRoot),
			actualTargets: [], pairs: [], complete: status === 'noApplicableRules', status, issues: 0, errors: [] };
	}
	run(scope: ScanScope): Promise<ScanResult> {
		if (this.disposed) { return Promise.resolve(this.noRules(scope, 'cancelled')); }
		if (this.registry.list().length === 0) { return Promise.resolve(this.noRules(scope, 'noApplicableRules')); }
		return new Promise<ScanResult>((resolve) => {
			const sequence = ++this.sequence;
			this.queue.push({ scope, sequence, runId: `code-style-${sequence}`,
				source: new vscode.CancellationTokenSource(), resolve });
			this.pump();
		});
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
		while (this.running.size < this.concurrency() && this.queue.length > 0) {
			const job = this.queue.shift()!;
			this.running.add(job);
			void this.planner.scan(job.scope, job.runId, job.sequence, job.source.token)
				.catch((error: unknown): ScanResult => {
					log.error(`Планирование: ${error instanceof Error ? error.stack ?? error.message : error}`);
					return { ...this.noRules(job.scope, 'error'), runId: job.runId, errors: [{ code: 'scanFailed', message: String(error) }] };
				})
				.then((result) => {
					if (!this.disposed) { this.changed.fire(result); }
					job.resolve(result);
				})
				.finally(() => {
					this.running.delete(job);
					job.source.dispose();
					this.pump();
				});
		}
	}

	/** Save/external-change events are coalesced by project, not by rule. */
	schedule(root: string, uri?: string, ruleIds?: readonly string[]): void {
		if (this.disposed || this.registry.list().length === 0) { return; }
		const key = projectKeyOf(root);
		let pending = this.pending.get(key);
		if (!pending) {
			pending = { root, mode: uri ? 'partial' : 'full', files: new Set<string>(),
				ruleIds: ruleIds ? new Set(ruleIds) : undefined };
			this.pending.set(key, pending);
		}
		if (!ruleIds) { pending.ruleIds = undefined; }
		else if (pending.ruleIds) { for (const rule of ruleIds) { pending.ruleIds.add(rule); } }
		if (!uri) { pending.mode = 'full'; pending.files.clear(); }
		else if (pending.mode === 'partial') { pending.files.add(uri); }
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => this.flush(), 300);
	}
	private flush(): void {
		this.timer = undefined;
		const items = [...this.pending.values()];
		this.pending.clear();
		for (const item of items) {
			void this.run({ projectRoot: item.root, mode: item.mode,
				files: item.mode === 'partial' ? [...item.files] : undefined,
				ruleIds: item.ruleIds ? [...item.ruleIds] : undefined });
		}
	}
	/** Do not cancel a full scan of other independent files; Store rejects its obsolete pair. */
	cancelForFile(uri: string): void {
		for (const job of this.running) {
			if (job.scope.mode === 'partial' && job.scope.files?.includes(uri)) { job.source.cancel(); }
		}
		for (const job of this.queue) {
			if (job.scope.mode === 'partial' && job.scope.files?.includes(uri)) { job.source.cancel(); }
		}
	}
	cancelProject(projectKey: string): void {
		this.pending.delete(projectKey);
		for (const job of [...this.queue, ...this.running]) {
			if (projectKeyOf(job.scope.projectRoot) === projectKey) { job.source.cancel(); }
		}
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		this.pending.clear();
		for (const job of this.queue) {
			job.source.cancel();
			job.resolve(this.noRules(job.scope, 'cancelled'));
			job.source.dispose();
		}
		this.queue.length = 0;
		for (const job of this.running) { job.source.cancel(); }
		this.changed.dispose();
	}
}
