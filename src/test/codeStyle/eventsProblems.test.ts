import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CodeStyleProblemsPublisher } from '../../features/codeStyle/presentation/problemsPublisher';
import { environment, type Environment } from './helpers';
suite('Code Style: Problems', () => {
	let e: Environment;
	let publisher: CodeStyleProblemsPublisher;
	setup(async () => { e = await environment(); publisher = new CodeStyleProblemsPublisher(e.store); });
	teardown(async () => { publisher.dispose(); await e.cleanup(); });
	const diagnostics = () => vscode.languages.getDiagnostics(vscode.Uri.parse(e.target.uri)).filter(d => d.source === '1C Code Style');
	test('0059: Преобразование Issue в Diagnostic', async () => {
		const issue = { ...e.issue(), relatedLocations: [e.issue().location] };
		await e.store.commit(await e.ticket(), [issue]);
		const found = diagnostics();
		assert.strictEqual(found.length, 1);
		assert.strictEqual(found[0].source, '1C Code Style');
		assert.strictEqual(found[0].code, 'test-a');
		assert.strictEqual(found[0].severity, vscode.DiagnosticSeverity.Warning);
		assert.ok(found[0].range.isEqual(new vscode.Range(0, 0, 0, 2)));
		assert.strictEqual(found[0].relatedInformation?.[0].location.uri.toString(), e.target.uri);
		e.store.fail(await e.ticket(2, 'test-b'), 'error', { code: 'runtime', message: 'Тестовые данные' });
		assert.strictEqual(diagnostics().length, 1);
	});
	test('0060: Объединение результатов и очистка stale', async () => {
		await e.store.commit(await e.ticket(), [e.issue()]);
		await e.store.commit(await e.ticket(2, 'test-b'), [e.issue('neighbor', 'test-b')]);
		assert.strictEqual(diagnostics().length, 2);
		await e.store.commit(await e.ticket(3), []);
		assert.deepStrictEqual(diagnostics().map(d => d.code), ['test-b']);
		e.store.invalidateUri(e.target.uri);
		assert.deepStrictEqual(diagnostics(), []);
	});
	test('0061: Изоляция от syntax-check и dispose', async () => {
		const syntax = vscode.languages.createDiagnosticCollection('1c-syntax-check');
		const uri = vscode.Uri.parse(e.target.uri);
		const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Тестовые данные');
		syntax.set(uri, [diagnostic]);
		try {
			await e.store.commit(await e.ticket(), [e.issue()]);
			e.store.setRuleRevisions(e.project.key, { 'test-a': 'r2' });
			assert.deepStrictEqual(diagnostics(), []);
			e.store.setRuleRevisions(e.project.key, { 'test-a': 'r1' });
			await e.store.commit(await e.ticket(2), [e.issue()]);
			e.store.removeUri(e.target.uri);
			assert.deepStrictEqual(diagnostics(), []);
			publisher.dispose();
			await e.store.commit(await e.ticket(3), [e.issue()]);
			assert.deepStrictEqual(diagnostics(), []);
			assert.strictEqual(syntax.get(uri)?.[0].message, 'Тестовые данные');
		}
		finally {
			syntax.dispose();
		}
	});
});
