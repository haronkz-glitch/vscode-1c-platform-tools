import * as fs from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import * as ts from 'typescript';
import { fixturePath } from '../fixtures/helpers/fixturePath';
/** Keep the subject unchanged while replacing explicit external module boundaries. */
export async function loadSubject<T>(file: string, dependencies: Record<string, unknown>): Promise<T> {
	const source = await fs.readFile(fixturePath('..', '..', 'features', 'codeStyle', file), 'utf8');
	const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	const execute = runInThisContext('(function(require, exports) {' + compiled + '\n})') as (require: (id: string) => unknown, exports: object) => void;
	execute(id => {
		if (!(id in dependencies)) {
			throw new Error('Неожиданная зависимость: ' + id);
		}
		return dependencies[id];
	}, exports);
	return exports as T;
}
