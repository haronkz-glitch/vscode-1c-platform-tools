import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { directoryKey, sameOrUnder } from '../../../shared/projectLayout';
import type { IssueLocation, ProjectRef, SourceRef, TargetDescriptor } from './types';

export const keyOfPath = (file: string): string => directoryKey(file);
export const projectKeyOf = (root: string): string => directoryKey(root);
export const sourceKeyOf = (project: ProjectRef, root: Pick<SourceRef, 'kind' | 'format' | 'root'>): string =>
	`${project.key}|${root.kind}|${root.format}|${keyOfPath(root.root)}`;
export const targetKeyOf = (source: SourceRef, kind: string, uri: string): string =>
	`${source.key}|${kind}|${keyOfPath(uri)}`;

export function within(file: string, root: string): boolean {
	return sameOrUnder(file, root);
}
export function safeResolve(root: string, candidate: string): string {
	const resolved = path.resolve(root, candidate);
	if (!within(resolved, root)) {
		throw new Error('Путь выходит за границу источника.');
	}
	return resolved;
}
export function issueLocationValid(location: IssueLocation): boolean {
	const { start, end } = location.range;
	return typeof location.uri === 'string' && location.uri.startsWith('file:') &&
		[start.line, start.character, end.line, end.character].every((number) =>
			Number.isSafeInteger(number) && number >= 0
		) &&
		(end.line > start.line || (end.line === start.line && end.character >= start.character));
}
export function stableHash(...parts: readonly string[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}
export function stableIssueId(ruleId: string, target: TargetDescriptor, anchor: string, occurrence: number): string {
	return stableHash(target.projectKey, target.sourceKey, target.targetKey, ruleId, anchor, String(occurrence));
}
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
export function targetCompare(a: TargetDescriptor, b: TargetDescriptor): number {
	return compareText(a.sourceKey, b.sourceKey) || compareText(a.targetKey, b.targetKey);
}
