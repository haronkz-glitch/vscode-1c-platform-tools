import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BslSourceProvider } from '../../features/codeStyle/sources/bslSource';
import { environment, type Environment, token } from './helpers';
suite('Code Style: BSL-источники', () => {
	let e: Environment;
	const provider = new BslSourceProvider();
	setup(async () => { e = await environment(); });
	teardown(async () => { await e.cleanup(); });
	test('0022: Обход модулей Ext', async () => {
		const extension = path.join(e.root, 'extension');
		const external = path.join(e.root, 'processor');
		for (const dir of [extension, external]) {
			await fs.mkdir(path.join(dir, 'Ext'), { recursive: true });
			await fs.writeFile(path.join(dir, 'Ext', 'Module.bsl'), 'Перем Тест;');
		}
		const project = { ...e.project, layout: { ...e.project.layout,
				extensions: [{ dir: extension, format: 'designer' as const, name: 'Test', isExtension: true }],
				processors: [{ dir: external, format: 'designer' as const, kind: 'processor' as const, name: 'Test', file: 'Test' }] } };
		const inventory = await provider.enumerate(project, {}, token);
		assert.strictEqual(inventory.complete, true);
		assert.strictEqual(inventory.targets.length, 3);
		assert.ok(inventory.targets.some(t => t.uri === e.target.uri));
		assert.strictEqual(new Set(inventory.targets.map(t => t.sourceKey)).size, 3);
	});
	test('0023: Исключения обхода и уникальные ключи', async () => {
		await e.write('build/Module.bsl');
		await e.write('nested/Module.bsl');
		const project = { ...e.project, excludedRoots: [path.join(e.dir, 'nested')] };
		const inventory = await provider.enumerate(project, {}, token);
		assert.strictEqual(inventory.targets.length, 1);
		assert.strictEqual(new Set(inventory.targets.map(t => t.targetKey)).size, 1);
	});
	test('0024: BOM, CRLF, dirty и сохранение', async () => {
		const file = vscode.Uri.parse(e.target.uri).fsPath;
		const text = '\uFEFFПерем Тест;\r\n';
		await fs.writeFile(file, text);
		const originalBytes = await fs.readFile(file);
		const first = await provider.read(e.project, e.target, token);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		// TextDocument exposes content without the encoding marker; the file must retain it.
		assert.strictEqual(first.text, document.getText());
		assert.strictEqual(first.text, text.slice(1));
		assert.deepStrictEqual(await fs.readFile(file), originalBytes);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), 'Тестовые данные');
		assert.ok(await vscode.workspace.applyEdit(edit));
		try {
			await assert.rejects(() => provider.read(e.project, e.target, token));
		}
		finally {
			await document.save();
		}
		const savedBytes = await fs.readFile(file);
		assert.deepStrictEqual([...savedBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
		const second = await provider.read(e.project, e.target, token);
		assert.notStrictEqual(first.version, second.version);
		assert.strictEqual(second.text, document.getText());
		assert.deepStrictEqual(await fs.readFile(file), savedBytes);
	});
	test('0025: Недоступный файл не создаётся', async () => {
		const file = vscode.Uri.parse(e.target.uri).fsPath;
		await fs.unlink(file);
		await assert.rejects(() => provider.read(e.project, e.target, token));
		const inventory = await provider.enumerate(e.project, { files: [e.target.uri] }, token);
		assert.strictEqual(inventory.complete, false);
		assert.ok(inventory.errors.length);
		await assert.rejects(() => fs.stat(file));
	});
});
