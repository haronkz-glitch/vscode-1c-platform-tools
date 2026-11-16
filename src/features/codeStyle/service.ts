import * as vscode from 'vscode';
import { RuleRegistry } from './core/ruleRegistry';
import { SettingsProvider } from './core/settings';
import { CodeStyleEngine } from './core/engine';
import { IssueStore } from './core/issueStore';
import { ScanPlanner } from './core/scanPlanner';
import { ScanScheduler } from './core/scheduler';
import { CodeStyleEvents, type SettingsChangedEvent } from './core/events';
import { SourceRegistry } from './sources/sourceRegistry';
import { BslSourceProvider } from './sources/bslSource';
import { MetadataSourceProvider } from './sources/metadataSource';
import { CodeStyleProblemsPublisher } from './presentation/problemsPublisher';
import { registerRules } from './rules/registerRules';
import { ActionRegistry } from './actions/registry';
import { ActionDispatcher } from './actions/dispatcher';
import { registerActions } from './actions/registerActions';
import type { JsonValue, ActionContext, ActionResult } from './actions/types';
import type { IssueFilter, IssueQueryResult, ProjectSettings, RuleDescriptor, ScanResult, ScanScope } from './core/types';

/** Sole internal facade for future panel and MCP adapters; no new VS Code commands. */
export class CodeStyleService implements vscode.Disposable {
	private readonly rules = new RuleRegistry();
	private readonly actions = new ActionRegistry();
	private readonly sources = new SourceRegistry();
	private readonly settings: SettingsProvider;
	private readonly engine = new CodeStyleEngine();
	private readonly store = new IssueStore();
	private readonly planner: ScanPlanner;
	private readonly scheduler: ScanScheduler;
	private readonly dispatcher: ActionDispatcher;
	private readonly publisher: CodeStyleProblemsPublisher;
	private readonly events: CodeStyleEvents;
	private readonly settingsEmitter = new vscode.EventEmitter<SettingsChangedEvent>();
	private disposed = false;

	readonly onDidChangeIssues = this.store.onDidChange;
	readonly onDidChangeSettings = this.settingsEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		registerRules(this.rules);
		registerActions(this.actions);
		this.settings = new SettingsProvider(this.rules);
		this.store.setRevisionResolver((root, ruleId) => this.settings.revisionFor(root, ruleId));
		this.sources.register(new BslSourceProvider());
		this.sources.register(new MetadataSourceProvider(context));
		this.planner = new ScanPlanner(this.rules, this.sources, this.settings, this.engine, this.store);
		this.scheduler = new ScanScheduler(this.planner, this.rules, this.store);
		this.publisher = new CodeStyleProblemsPublisher(this.store);
		const actionContext: ActionContext = {
			listRules: () => this.listRules(),
			getSettings: (root) => {
				const settings = this.getSettings(root);
				return settings ? JSON.parse(JSON.stringify(settings)) as ProjectSettings : undefined;
			},
			getIssues: (filter) => JSON.parse(JSON.stringify(this.getIssues(filter))) as IssueQueryResult,
			check: async (scope) => JSON.parse(JSON.stringify(await this.scan(scope))) as ScanResult,
		};
		this.dispatcher = new ActionDispatcher(this.actions, actionContext);
		this.events = new CodeStyleEvents(this.rules, this.settings, this.store, this.scheduler,
			(event) => this.settingsEmitter.fire(event));
	}
	readonly onDidChangeScanState = (listener: (state: ScanResult) => unknown, thisArgs?: unknown,
		disposables?: vscode.Disposable[]): vscode.Disposable =>
		this.scheduler.onDidChangeScanState(listener, thisArgs, disposables);

	listRules(): readonly RuleDescriptor[] {
		return this.rules.list().map((rule) => ({
			id: rule.id, title: rule.title, description: rule.description, area: rule.area,
			category: rule.category, defaultSeverity: rule.defaultSeverity,
			defaultEnabled: rule.defaultEnabled, sourceKinds: [...rule.sourceKinds],
		}));
	}
	getSettings(projectRoot: string): ProjectSettings | undefined {
		return this.settings.safeRead(projectRoot).settings;
	}
	getIssues(filter?: IssueFilter): IssueQueryResult { return this.store.query(filter); }
	getScanState(filter?: IssueFilter): IssueQueryResult { return this.store.query(filter); }
	scan(scope: ScanScope): Promise<ScanResult> { return this.scheduler.run(scope); }
	scanProject(projectRoot: string, ruleIds?: readonly string[]): Promise<ScanResult> {
		return this.scan({ projectRoot, mode: 'full', ruleIds });
	}
	scanFiles(projectRoot: string, files: readonly string[], ruleIds?: readonly string[]): Promise<ScanResult> {
		return this.scan({ projectRoot, mode: 'partial', files, ruleIds });
	}
	scanTargets(projectRoot: string, targetKeys: readonly string[], ruleIds?: readonly string[]): Promise<ScanResult> {
		return this.scan({ projectRoot, mode: 'partial', targetKeys, ruleIds });
	}
	dispatch(actionId: string, payload: JsonValue): Promise<ActionResult> {
		return this.dispatcher.dispatch(actionId, payload);
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.events.dispose();
		this.scheduler.dispose();
		this.publisher.dispose();
		this.store.dispose();
		this.settingsEmitter.dispose();
	}
}
