import * as vscode from 'vscode';
import { IssueStore } from '../core/issueStore';
import type { Issue, StoreChange } from '../core/types';

/** A separate Problems collection; syntax-check diagnostics are not touched. */
export class CodeStyleProblemsPublisher implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('1c-code-style');
	private readonly subscription: vscode.Disposable;
	private disposed = false;

	constructor(private readonly store: IssueStore) {
		this.subscription = store.onDidChange((event) => this.publish(event));
	}

	private publish(change: StoreChange): void {
		if (this.disposed) { return; }
		for (const uri of new Set(change.uris)) {
			const issues = this.store.getIssues({ uri });
			const diagnostics = issues.map((issue) => this.diagnostic(issue));
			this.collection.set(vscode.Uri.parse(uri), diagnostics);
		}
	}
	private diagnostic(issue: Issue): vscode.Diagnostic {
		const location = issue.location;
		const range = new vscode.Range(
			location.range.start.line, location.range.start.character,
			location.range.end.line, location.range.end.character
		);
		const severity: Record<Issue['severity'], vscode.DiagnosticSeverity> = {
			error: vscode.DiagnosticSeverity.Error,
			warning: vscode.DiagnosticSeverity.Warning,
			information: vscode.DiagnosticSeverity.Information,
			hint: vscode.DiagnosticSeverity.Hint,
		};
		const diagnostic = new vscode.Diagnostic(range, issue.message, severity[issue.severity]);
		diagnostic.code = issue.ruleId;
		diagnostic.source = '1C Code Style';
		if (issue.relatedLocations?.length) {
			diagnostic.relatedInformation = issue.relatedLocations.map((related) =>
				new vscode.DiagnosticRelatedInformation(
					new vscode.Location(vscode.Uri.parse(related.uri), new vscode.Range(
						related.range.start.line, related.range.start.character,
						related.range.end.line, related.range.end.character
					)), 'Связанное место'
				));
		}
		return diagnostic;
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.subscription.dispose();
		this.collection.dispose();
	}
}
