import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { CodeStyleService } from './service';

const log = logger.scope('code-style');
let active: CodeStyleService | undefined;

/** The feature owns one service per activation; independent failures do not abort bootstrap. */
export function registerCodeStyleFeature(context: vscode.ExtensionContext): vscode.Disposable {
	if (active) { return new vscode.Disposable(() => undefined); }
	try {
		const service = new CodeStyleService(context);
		active = service;
		return new vscode.Disposable(() => {
			if (active !== service) { return; }
			active = undefined;
			service.dispose();
		});
	} catch (error) {
		log.error(`Code Style не инициализирован: ${error instanceof Error ? error.stack ?? error.message : error}`);
		return new vscode.Disposable(() => undefined);
	}
}
/** Used by future in-extension adapters; no separate process or transport. */
export function getCodeStyleService(): CodeStyleService | undefined { return active; }
