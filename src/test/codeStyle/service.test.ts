import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CodeStyleService } from '../../features/codeStyle/service';
import { registerCodeStyleFeature, getCodeStyleService } from '../../features/codeStyle/registerCodeStyleFeature';
import { BslSourceProvider } from '../../features/codeStyle/sources/bslSource';
import { MetadataSourceProvider } from '../../features/codeStyle/sources/metadataSource';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';
import { environment, type Environment } from './helpers';
suite('Code Style: сервис', () => {
	let e: Environment;
	let service: CodeStyleService;
	setup(async () => { e = await environment(); service = new CodeStyleService(createMockExtensionContext(e.root)); });
	teardown(async () => { service.dispose(); await e.cleanup(); });
	test('0062: Пустые production-регистры', async () => {
		assert.deepStrictEqual(service.listRules(), []);
		assert.deepStrictEqual(service.getIssues().issues, []);
		assert.strictEqual((await service.dispatch('missing', {})).error?.code, 'unknownAction');
	});
	test('0063: Явный scope, результаты и события фасада', async () => {
		const states: string[] = [];
		const subscription = service.onDidChangeScanState(state => states.push(state.status));
		try {
			const full = await service.scanProject(e.root, ['test-a']);
			assert.strictEqual(full.requested.mode, 'full');
			const files = await service.scanFiles(e.root, [e.target.uri]);
			assert.deepStrictEqual(files.requested.files, [e.target.uri]);
			const targets = await service.scanTargets(e.root, [e.target.targetKey]);
			assert.deepStrictEqual(targets.requested.targetKeys, [e.target.targetKey]);
			for (const result of [full, files, targets]) {
				assert.strictEqual(result.status, 'noApplicableRules');
				assert.strictEqual(result.complete, true);
				assert.strictEqual(result.requested.projectRoot, e.root);
			}
			assert.deepStrictEqual(states, ['noApplicableRules', 'noApplicableRules', 'noApplicableRules']);
			assert.ok(service.getScanState().scans.length > 0);
		}
		finally {
			subscription.dispose();
		}
	});
	test('0064: Пустой каркас не читает источники', async () => {
		const bslEnumerate = BslSourceProvider.prototype.enumerate;
		const bslRead = BslSourceProvider.prototype.read;
		const metadataEnumerate = MetadataSourceProvider.prototype.enumerate;
		const metadataRead = MetadataSourceProvider.prototype.read;
		let sourceCalls = 0;
		const forbidden = async (): Promise<never> => { sourceCalls++; return assert.fail('Пустой реестр обратился к источнику'); };
		const before = await vscode.commands.getCommands(true);
		BslSourceProvider.prototype.enumerate = forbidden;
		BslSourceProvider.prototype.read = forbidden;
		MetadataSourceProvider.prototype.enumerate = forbidden;
		MetadataSourceProvider.prototype.read = forbidden;
		try {
			assert.strictEqual((await service.scanProject(e.root)).status, 'noApplicableRules');
			assert.strictEqual(sourceCalls, 0);
			assert.deepStrictEqual((await vscode.commands.getCommands(true)).filter(id => id.startsWith('1c-platform-tools.')).sort(), before.filter(id => id.startsWith('1c-platform-tools.')).sort());
			assert.deepStrictEqual(service.getIssues().issues, []);
		}
		finally {
			BslSourceProvider.prototype.enumerate = bslEnumerate;
			BslSourceProvider.prototype.read = bslRead;
			MetadataSourceProvider.prototype.enumerate = metadataEnumerate;
			MetadataSourceProvider.prototype.read = metadataRead;
		}
	});
	test('0065: Однократная регистрация и освобождение', () => {
		const existing = getCodeStyleService();
		const first = registerCodeStyleFeature(createMockExtensionContext(e.root));
		const active = getCodeStyleService();
		assert.ok(active);
		const second = registerCodeStyleFeature(createMockExtensionContext(e.root));
		assert.strictEqual(getCodeStyleService(), active);
		second.dispose();
		assert.strictEqual(getCodeStyleService(), active);
		first.dispose();
		first.dispose();
		assert.strictEqual(getCodeStyleService(), existing);
	});
});
