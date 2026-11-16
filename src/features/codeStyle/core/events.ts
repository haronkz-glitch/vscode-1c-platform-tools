import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { onDidChangeMetadataFiles } from '../../metadata/metadataFileChanges';
import { onDidChangeProjectLayout } from '../../../shared/projectLayoutWatch';
import { onDidChangeProjects } from '../../../shared/workspaceProjects';
import { RuleRegistry } from './ruleRegistry';
import { SettingsProvider } from './settings';
import { IssueStore, type AffectedPair } from './issueStore';
import { ScanScheduler } from './scheduler';
import { projectForFile, projectsForWorkspace, sourceRoots } from '../sources/projectSource';
import { fileFingerprint } from '../sources/bslSource';
import type { ProjectRef, ProjectSettings, SourceKind } from './types';

const log = logger.scope('code-style');
const isWatched = (file: string): boolean => /\.(?:bsl|xml|mdo)$/i.test(file);
const isMetadata = (file: string): boolean => /\.(?:xml|mdo)$/i.test(file);

export interface SettingsChangedEvent { readonly projectKey: string }
/** Routes file/project/settings signals into Store invalidation and coalesced schedules. */
export class CodeStyleEvents implements vscode.Disposable {
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly watchers: vscode.Disposable[] = [];
	private readonly known = new Map<string, string>();
	private readonly versions = new Map<string, string>();
	private readonly dirty = new Set<string>();
	private serial = 0;
	private disposed = false;
	constructor(
		private readonly rules: RuleRegistry,
		private readonly settings: SettingsProvider,
		private readonly store: IssueStore,
		private readonly scheduler: ScanScheduler,
		private readonly onSettingsChanged: (event: SettingsChangedEvent) => void
	) {
		this.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.disposed || this.rules.list().length === 0 || event.document.uri.scheme !== 'file' ||
					!isWatched(event.document.uri.fsPath)) { return; }
				const uri = event.document.uri.toString();
				if (event.document.isDirty) {
					if (!this.dirty.has(uri)) {
						this.dirty.add(uri);
						this.store.invalidateUri(uri);
						this.scheduler.cancelForFile(uri);
					}
				} else if (this.dirty.delete(uri)) {
					// Revert/discard made the persisted source authoritative again.
					void this.changedFile(event.document.uri, true);
				}
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (document.uri.scheme === 'file' && this.dirty.delete(document.uri.toString())) {
					void this.changedFile(document.uri, true);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (document.uri.scheme === 'file') { void this.changedFile(document.uri); }
			}),
			vscode.workspace.onDidDeleteFiles((event) => {
				for (const uri of event.files) { void this.deletedFile(uri); }
			}),
			vscode.workspace.onDidRenameFiles((event) => {
				for (const file of event.files) {
					void this.deletedFile(file.oldUri);
					void this.changedFile(file.newUri, false, true);
				}
			}),
			onDidChangeMetadataFiles((files) => {
				for (const file of files) { void this.changedFile(vscode.Uri.file(file)); }
			}),
			onDidChangeProjectLayout(() => { void this.refreshProjects(true); }),
			onDidChangeProjects(() => { void this.refreshProjects(false); }),
			vscode.workspace.onDidChangeConfiguration((event) => { void this.configurationChanged(event); }),
		);
		if (rules.list().length) { void this.refreshProjects(false); }
	}
	private enabled(project: ProjectRef): { settings?: ProjectSettings; kinds: Set<SourceKind> } {
		const settings = this.settings.safeRead(project.root).settings;
		const kinds = new Set<SourceKind>();
		if (settings?.enabled) {
			for (const rule of this.rules.select(settings)) {
				for (const kind of rule.sourceKinds) { kinds.add(kind); }
			}
		}
		return { settings, kinds };
	}
	private async refreshProjects(_layoutChanged: boolean): Promise<void> {
		if (this.disposed || this.rules.list().length === 0) { return; }
		const serial = ++this.serial;
		try {
			const projects = await projectsForWorkspace();
			if (this.disposed || serial !== this.serial) { return; }
			const next = new Map<string, string>();
			const watchers: vscode.Disposable[] = [];
			const watchRoots = new Set<string>();
			for (const project of projects) {
				const roots = sourceRoots(project);
				const signature = JSON.stringify(roots.map((root) => root.key).sort());
				next.set(project.key, signature);
				const old = this.known.get(project.key);
				const enabled = this.enabled(project);
				if (old !== undefined && old !== signature) {
					this.store.invalidateProject(project.key);
					this.scheduler.cancelProject(project.key);
					if (enabled.settings?.enabled && enabled.settings.scanOnSave && enabled.kinds.size > 0) {
						this.scheduler.schedule(project.root);
					}
				}
				// Disabling auto-scan must NOT disable watchers: stale results still disappear.
				if (!enabled.settings?.enabled || enabled.kinds.size === 0) { continue; }
				for (const source of roots) {
					const mkWatcher = (glob: string): void => {
						const id = source.root + '|' + glob;
						if (watchRoots.has(id)) { return; }
						watchRoots.add(id);
						const watcher = vscode.workspace.createFileSystemWatcher(
							new vscode.RelativePattern(vscode.Uri.file(source.root), glob)
						);
						watchers.push(watcher,
							watcher.onDidChange((uri) => { void this.changedFile(uri); }),
							watcher.onDidCreate((uri) => { void this.changedFile(uri, false, true); }),
							watcher.onDidDelete((uri) => { void this.deletedFile(uri); }));
					};
					if (enabled.kinds.has('bsl')) { mkWatcher('**/*.bsl'); }
					if (enabled.kinds.has('metadata')) { mkWatcher('**/*.{xml,mdo}'); }
				}
			}
			if (this.disposed || serial !== this.serial) {
				for (const disposable of watchers) { disposable.dispose(); }
				return;
			}
			for (const key of this.known.keys()) {
				if (!next.has(key)) {
					this.scheduler.cancelProject(key);
					this.store.removeProject(key);
				}
			}
			for (const watcher of this.watchers.splice(0)) { watcher.dispose(); }
			this.watchers.push(...watchers);
			this.known.clear();
			for (const [key, value] of next) { this.known.set(key, value); }
		} catch (error) {
			log.error('Событие проектов: ' + (error instanceof Error ? error.stack ?? error.message : error));
		}
	}
	private rescheduleAffected(project: ProjectRef, affected: readonly AffectedPair[]): void {
		const dependent = affected.filter((item) => item.projectKey === project.key);
		if (!dependent.length) { return; }
		this.scheduler.scheduleTargets(project.root,
			[...new Set(dependent.map((item) => item.targetKey))],
			[...new Set(dependent.map((item) => item.ruleId))]);
	}
	private async changedFile(uri: vscode.Uri, reverted = false, created = false): Promise<void> {
		if (this.disposed || this.rules.list().length === 0 || uri.scheme !== 'file' || !isWatched(uri.fsPath)) { return; }
		const id = uri.toString();
		const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === id);
		if (open?.isDirty) {
			if (!this.dirty.has(id)) {
				this.dirty.add(id);
				this.store.invalidateUri(id);
				this.scheduler.cancelForFile(id);
			}
			return;
		}
		const wasDirty = this.dirty.delete(id) || reverted;
		let version: string;
		try { version = await fileFingerprint(uri.fsPath); }
		catch (error) {
			// An unreadable file may still exist; deletion requires its own confirmed event.
			this.store.invalidateUri(id);
			log.warn('Изменённый файл недоступен: ' + uri.fsPath + ': ' + String(error));
			return;
		}
		if (this.disposed) { return; }
		const recorded = this.versions.get(id) ?? this.store.knownSourceVersion(id);
		if (!wasDirty && !created && recorded === version) { return; }
		this.versions.set(id, version);
		const affected = this.store.invalidateUri(id);
		this.scheduler.cancelForFile(id);
		try {
			const project = await projectForFile(id);
			if (!project || this.disposed) { return; }
			this.store.bumpInventory(project.key);
			const { settings, kinds } = this.enabled(project);
			if (!settings?.enabled || !settings.scanOnSave) { return; }
			if (created && isMetadata(uri.fsPath) || /Configuration\.(?:xml|mdo)$/i.test(uri.fsPath)) {
				if (kinds.has('metadata')) { this.scheduler.schedule(project.root, undefined, undefined, ['metadata']); }
			} else if (isMetadata(uri.fsPath)) {
				if (kinds.has('metadata')) {
					if (affected.some((item) => item.targetUri === id)) { this.scheduler.schedule(project.root, id); }
					else { this.scheduler.schedule(project.root, undefined, undefined, ['metadata']); }
				}
			} else if (kinds.has('bsl')) {
				this.scheduler.schedule(project.root, id);
			}
			this.rescheduleAffected(project, affected.filter((item) => item.targetUri !== id));
		} catch (error) {
			log.warn('Не удалось назначить анализ ' + uri.fsPath + ': ' + String(error));
		}
	}
	private async deletedFile(uri: vscode.Uri): Promise<void> {
		if (this.disposed || this.rules.list().length === 0 ||
			uri.scheme !== 'file' || !isWatched(uri.fsPath)) { return; }
		const id = uri.toString();
		this.versions.delete(id);
		this.dirty.delete(id);
		this.scheduler.cancelForFile(id);
		const affected = this.store.removeUri(id);
		try {
			const project = await projectForFile(id);
			if (!project || this.disposed) { return; }
			this.store.bumpInventory(project.key);
			const { settings, kinds } = this.enabled(project);
			if (!settings?.enabled || !settings.scanOnSave) { return; }
			if (isMetadata(uri.fsPath) && kinds.has('metadata')) {
				// A deleted metadata object may change the tree and source inventory.
				this.scheduler.schedule(project.root, undefined, undefined, ['metadata']);
			}
			this.rescheduleAffected(project, affected);
		} catch (error) {
			log.warn('Не удалось обработать удаление ' + uri.fsPath + ': ' + String(error));
		}
	}
	private async configurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
		if (this.disposed || this.rules.list().length === 0 ||
			!event.affectsConfiguration('1c-platform-tools.codeStyle')) { return; }
		try {
			const projects = await projectsForWorkspace();
			for (const project of projects) {
				if (this.disposed ||
					!event.affectsConfiguration('1c-platform-tools.codeStyle', vscode.Uri.file(project.root))) { continue; }
				const settings = this.settings.safeRead(project.root).settings;
				if (!settings) { this.store.invalidateProject(project.key, false); continue; }
				const changedRules = this.store.setRuleRevisions(project.key, Object.fromEntries(
					Object.entries(settings.rules).map(([id, rule]) => [id, rule.revision])
				));
				this.onSettingsChanged({ projectKey: project.key });
				if (settings.enabled && changedRules.length) {
					this.scheduler.schedule(project.root, undefined, changedRules);
				}
			}
			await this.refreshProjects(false);
		} catch (error) {
			log.error('Изменение Code Style settings: ' + (error instanceof Error ? error.stack ?? error.message : error));
		}
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.serial += 1;
		for (const disposable of [...this.watchers, ...this.subscriptions]) { disposable.dispose(); }
		this.watchers.length = 0; this.subscriptions.length = 0;
		this.known.clear(); this.versions.clear(); this.dirty.clear();
	}
}
