import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { loadSubject } from './loadSubject';
import { environment, type Environment, rule } from './helpers';
import { CodeStyleEvents } from '../../features/codeStyle/core/events';
import { RuleRegistry } from '../../features/codeStyle/core/ruleRegistry';
import { SettingsProvider } from '../../features/codeStyle/core/settings';
import { ScanScheduler } from '../../features/codeStyle/core/scheduler';
import { IssueStore } from '../../features/codeStyle/core/issueStore';
import * as identity from '../../features/codeStyle/core/identity';
import * as projects from '../../features/codeStyle/sources/projectSource';
import * as layout from '../../shared/projectLayout';
import { logger } from '../../shared/logger';
suite('Code Style: события', () => {
	let e: Environment;
	let events: CodeStyleEvents;
	let signals: vscode.Disposable[];
	let dirty: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
	let saved: vscode.EventEmitter<vscode.TextDocument>;
	let metadata: vscode.EventEmitter<string[]>;
	let watcher: vscode.EventEmitter<vscode.Uri>;
	let settings: SettingsProvider;
	let auto: boolean;
	let scopes: unknown[][];
	const settle = async () => {
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
	};
	setup(async () => {
		e = await environment();
		auto = true;
		scopes = [];
		signals = [];
		dirty = new vscode.EventEmitter();
		saved = new vscode.EventEmitter();
		metadata = new vscode.EventEmitter();
		watcher = new vscode.EventEmitter();
		signals.push(dirty, saved, metadata, watcher);
		const noEvent = () => new vscode.Disposable(() => undefined);
		const rules = new RuleRegistry();
		rules.register(rule('test-a', { sourceKinds: ['bsl', 'metadata'] }));
		settings = new SettingsProvider(rules);
		const read = settings.safeRead.bind(settings);
		settings.safeRead = root => { const result = read(root); return result.settings ? { settings: { ...result.settings, scanOnSave: auto } } : result; };
		const queue = { cancelForFile: () => undefined, cancelProject: () => undefined,
			schedule: (...scope: unknown[]) => { scopes.push(scope); }, scheduleSource: (...scope: unknown[]) => { scopes.push(scope); }, schedulePairs: (...scope: unknown[]) => { scopes.push(scope); } } as unknown as ScanScheduler;
		const workspace = Object.create(vscode.workspace);
		Object.defineProperties(workspace, Object.fromEntries(Object.entries({ textDocuments: [],
			onDidChangeTextDocument: dirty.event, onDidSaveTextDocument: saved.event,
			onDidCloseTextDocument: noEvent, onDidDeleteFiles: noEvent, onDidRenameFiles: noEvent, onDidChangeConfiguration: noEvent,
			createFileSystemWatcher: () => ({ onDidChange: watcher.event, onDidCreate: noEvent, onDidDelete: noEvent, dispose: () => undefined }),
		}).map(([key, value]) => [key, { value, configurable: true }])));
		const api = { ...vscode, workspace };
		const subject = await loadSubject<{
			CodeStyleEvents: typeof CodeStyleEvents;
		}>('core/events.ts', {
			vscode: api, '../../../shared/projectLayout': layout, './identity': identity, '../../../shared/logger': { logger },
			'../../metadata/metadataFileChanges': { onDidChangeMetadataFiles: metadata.event },
			'../../../shared/projectLayoutWatch': { onDidChangeProjectLayout: noEvent }, '../../../shared/workspaceProjects': { onDidChangeProjects: noEvent },
			'./ruleRegistry': { RuleRegistry }, './settings': { SettingsProvider }, './issueStore': { IssueStore }, './scheduler': { ScanScheduler },
			'../sources/projectSource': { ...projects, projectForFile: async () => e.project, projectsForWorkspace: async () => [e.project] },
			'../sources/bslSource': { fileFingerprint: async () => 'changed-version' },
		});
		events = new subject.CodeStyleEvents(rules, settings, e.store, queue, () => undefined);
		await settle();
	});
	teardown(async () => {
		events?.dispose();
		for (const signal of signals) {
			signal.dispose();
		}
		await e.cleanup();
	});
	test('0057: dirty немедленно скрывает замечания, save и watcher одной версии объединяются', async () => {
		await e.store.commit(await e.ticket(), [e.issue()]);
		const document = { uri: vscode.Uri.parse(e.target.uri), isDirty: true } as vscode.TextDocument;
		dirty.fire({ document } as vscode.TextDocumentChangeEvent);
		assert.deepStrictEqual(e.store.getIssues(), []);
		saved.fire({ ...document, isDirty: false } as vscode.TextDocument);
		await settle();
		const count = scopes.length;
		assert.ok(count > 0);
		watcher.fire(document.uri);
		await settle();
		assert.strictEqual(scopes.length, count);
		auto = false;
		dirty.fire({ document } as vscode.TextDocumentChangeEvent);
		saved.fire({ ...document, isDirty: false } as vscode.TextDocument);
		await settle();
		assert.strictEqual(scopes.length, count);
		assert.deepStrictEqual(e.store.getIssues(), []);
	});
	test('0058: штатный metadata-сигнал и watcher ограничены одним source', async () => {
		const uri = vscode.Uri.file(e.dir + '/Configuration.xml');
		metadata.fire([uri.fsPath]);
		await settle();
		assert.strictEqual(scopes.length, 1);
		assert.deepStrictEqual(scopes[0], [e.root, projects.sourceRoots(e.project)[0].key, 'metadata']);
		watcher.fire(uri);
		await settle();
		assert.strictEqual(scopes.length, 1);
		events.dispose();
		metadata.fire([uri.fsPath]);
		watcher.fire(uri);
		await settle();
		assert.strictEqual(scopes.length, 1);
	});
});
