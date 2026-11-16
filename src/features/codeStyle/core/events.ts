import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { onDidChangeMetadataFiles } from '../../metadata/metadataFileChanges';
import { onDidChangeProjectLayout } from '../../../shared/projectLayoutWatch';
import { onDidChangeProjects } from '../../../shared/workspaceProjects';
import { RuleRegistry } from './ruleRegistry';
import { SettingsProvider } from './settings';
import { IssueStore } from './issueStore';
import { ScanScheduler } from './scheduler';
import { projectForFile, projectsForWorkspace, sourceRoots } from '../sources/projectSource';
import { fileFingerprint } from '../sources/bslSource';
import type { ProjectRef, ProjectSettings, SourceKind } from './types';

const log = logger.scope('code-style');
const isWatched = (file: string): boolean => /\.(?:bsl|xml|mdo)$/i.test(file);

export interface SettingsChangedEvent { readonly projectKey: string }
/**
 * One event coordinator. All invalidation happens before scheduling; no action
 * dispatcher, editor-specific scanning, or UI/metadata state is involved.
 */
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
				if (this.rules.list().length === 0 || event.document.uri.scheme !== 'file' ||
					!event.document.isDirty || !isWatched(event.document.uri.fsPath)) { return; }
				const uri = event.document.uri.toString();
				if (!this.dirty.has(uri)) {
					this.dirty.add(uri);
					this.store.invalidateUri(uri);
					this.scheduler.cancelForFile(uri);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (document.uri.scheme === 'file') { void this.changedFile(document.uri); }
			}),
			vscode.workspace.onDidDeleteFiles((event) => {
				for (const uri of event.files) { this.deletedFile(uri); }
			}),
			vscode.workspace.onDidRenameFiles((event) => {
				for (const file of event.files) {
					this.deletedFile(file.oldUri);
					void this.changedFile(file.newUri);
				}
			}),
			onDidChangeMetadataFiles((files) => {
				for (const file of files) { void this.changedFile(vscode.Uri.file(file)); }
			}),
			onDidChangeProjectLayout(() => { void this.refreshProjects(true); }),
			onDidChangeProjects(() => { void this.refreshProjects(false); }),
			vscode.workspace.onDidChangeConfiguration((event) => { void this.configurationChanged(event); }),
		);
		// No project enumeration, watchers or JVM startup in the empty-registry stage.
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
	private async refreshProjects(layoutChanged: boolean): Promise<void> {
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
				if (old !== undefined && old !== signature) {
					this.store.invalidateProject(project.key);
					this.scheduler.cancelProject(project.key);
					const refreshed = this.enabled(project);
					if (refreshed.settings?.enabled && refreshed.settings.scanOnSave &&
						this.rules.select(refreshed.settings).length > 0) { this.scheduler.schedule(project.root); }
				} else if (layoutChanged && old !== undefined && old === signature) {
					// Layout was rebuilt but the set of source roots stayed unchanged.
					// Ordinary file events invalidate individual targets separately.
				}
				const enabled = this.enabled(project);
				if (!enabled.settings?.enabled || !enabled.settings.scanOnSave || enabled.kinds.size === 0) { continue; }
				for (const source of roots) {
					const mkWatcher = (glob: string): void => {
						const id = `${source.root}|${glob}`;
						if (watchRoots.has(id)) { return; }
						watchRoots.add(id);
						const watcher = vscode.workspace.createFileSystemWatcher(
							new vscode.RelativePattern(vscode.Uri.file(source.root), glob)
						);
						watchers.push(watcher, watcher.onDidChange((uri) => { void this.changedFile(uri); }),
							watcher.onDidCreate((uri) => { void this.changedFile(uri); }),
							watcher.onDidDelete((uri) => this.deletedFile(uri)));
					};
					if (enabled.kinds.has('bsl')) { mkWatcher('**/*.bsl'); }
					if (enabled.kinds.has('metadata')) { mkWatcher('**/*.{xml,mdo}'); }
				}
			}
			for (const key of this.known.keys()) {
				if (!next.has(key)) {
					this.scheduler.cancelProject(key);
					this.store.removeProject(key);
				}
			}
			if (this.disposed || serial !== this.serial) {
				for (const watcher of watchers) { watcher.dispose(); }
				return;
			}
			for (const watcher of this.watchers.splice(0)) { watcher.dispose(); }
			this.watchers.push(...watchers);
			this.known.clear();
			for (const [key, value] of next) { this.known.set(key, value); }
		} catch (error) {
			log.error(`Событие проектов: ${error instanceof Error ? error.stack ?? error.message : error}`);
		}
	}
	private async changedFile(uri: vscode.Uri): Promise<void> {
		if (this.disposed || this.rules.list().length === 0 || uri.scheme !== 'file' || !isWatched(uri.fsPath)) { return; }
		const id = uri.toString();
		const wasDirty = this.dirty.delete(id);
		let version: string;
		try { version = await fileFingerprint(uri.fsPath); }
		catch (error) {
			// Unreadable is not the same as confirmed deleted.
			this.store.invalidateUri(id);
			log.warn(`Изменённый файл недоступен: ${uri.fsPath}: ${String(error)}`);
			return;
		}
		if (this.disposed) { return; }
		const recorded = this.versions.get(id) ?? this.store.knownSourceVersion(id);
		if (!wasDirty && recorded === version) { return; }
		this.versions.set(id, version);
		this.store.invalidateUri(id);
		this.scheduler.cancelForFile(id);
		try {
			const project = await projectForFile(id);
			if (!project || this.disposed) { return; }
			// Changed files may alter the inventory; an older full run cannot prune new results.
			this.store.bumpInventory(project.key);
			const settings = this.enabled(project).settings;
			if (settings?.enabled && settings.scanOnSave) {
				if (/Configuration\.(?:xml|mdo)$/i.test(uri.fsPath)) { this.scheduler.schedule(project.root); }
				else { this.scheduler.schedule(project.root, id); }
			}
		} catch (error) {
			log.warn(`Не удалось назначить анализ ${uri.fsPath}: ${String(error)}`);
		}
	}
	private deletedFile(uri: vscode.Uri): void {
		if (this.disposed || this.rules.list().length === 0 ||
			uri.scheme !== 'file' || !isWatched(uri.fsPath)) { return; }
		const id = uri.toString();
		this.versions.delete(id);
		this.dirty.delete(id);
		this.scheduler.cancelForFile(id);
		this.store.removeUri(id);
		void projectForFile(id).then((project) => {
			if (!project || this.disposed) { return; }
			this.store.bumpInventory(project.key);
			const settings = this.enabled(project).settings;
			if (settings?.enabled && settings.scanOnSave && /\\.(?:xml|mdo)$/i.test(uri.fsPath)) {
				this.scheduler.schedule(project.root);
			}
		}).catch((error: unknown) => log.warn(`Не удалось обработать удаление ${uri.fsPath}: ${String(error)}`));
	}
	private async configurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
		if (this.disposed || this.rules.list().length === 0 ||
			!event.affectsConfiguration('1c-platform-tools.codeStyle')) { return; }
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
			if (settings.enabled && changedRules.length > 0) {
				this.scheduler.schedule(project.root, undefined, changedRules);
			}
		}
		await this.refreshProjects(false);
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.serial += 1;
		for (const disposable of [...this.watchers, ...this.subscriptions]) { disposable.dispose(); }
		this.watchers.length = 0;
		this.subscriptions.length = 0;
		this.known.clear(); this.versions.clear(); this.dirty.clear();
	}
}
