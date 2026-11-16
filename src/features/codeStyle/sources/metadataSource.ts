import * as path from 'node:path';
import * as vscode from 'vscode';
import { externalEntry } from '../../../shared/projectLayout';
import { loadProjectMetadataTree, type MetadataItemDto, type MetadataSourceDto, type ProjectMetadataTreeDto } from '../../metadata/metadataTreeService';
import { ensureMdSparrowRuntime } from '../../metadata/mdSparrowBootstrap';
import { runMdSparrowParamsRead, type MdSparrowParams } from '../../metadata/mdSparrowParams';
import { metadataFileVersion } from '../../metadata/metadataFileChanges';
import { mdSparrowSchemaFlagFromConfigurationXml, designerXmlVersionToMdSparrowFlag } from '../../metadata/mdSparrowSchemaVersion';
import { stableHash, targetCompare, targetKeyOf } from '../core/identity';
import { SourceDataError } from '../core/sourceVersion';
import type { CodeStyleError, ProjectRef, SourceInventory, SourceProvider, SourceSelection, TargetDescriptor, TargetSnapshot, SourceRef } from '../core/types';
import { ensureSafeFile, filePath, fileUri, sourceForFile, sourceRoots, sameFile } from './projectSource';

function fallbackExternals(project: ProjectRef): ProjectMetadataTreeDto {
	const sources: MetadataSourceDto[] = [];
	for (const entry of [...project.layout.processors, ...project.layout.reports, ...project.layout.testProcessors]) {
		const file = externalEntry(entry);
		sources.push({
			kind: entry.kind, id: file, label: entry.name,
			configurationXmlRelativePath: '', metadataRootRelativePath: '',
			groups: [{ id: 'external', label: '', iconHint: '',
				items: [{ objectType: entry.kind === 'report' ? 'ExternalReport' : 'ExternalDataProcessor',
					name: entry.name, relativePath: path.relative(project.root, file) }] }],
		});
	}
	return { projectRoot: project.root, mainSchemaVersion: '', mainSchemaVersionFlag: '', sources };
}
function itemsOf(source: MetadataSourceDto): MetadataItemDto[] {
	return source.groups.flatMap((group) => [...group.items, ...(group.subgroups ?? []).flatMap((sub) => sub.items)]);
}
function safePath(project: ProjectRef, relative: string): string {
	const file = path.resolve(project.root, relative);
	if (!sourceForFile(project, file)) { throw new Error('Путь metadata вне поддерживаемого источника.'); }
	return file;
}
function sourceByEntry(project: ProjectRef, file: string): SourceRef | undefined {
	return sourceRoots(project).find((source) => sameFile(source.entry, file));
}
function schemaFlag(raw: string | undefined): string | undefined {
	if (!raw) { return undefined; }
	if (/^V\d+(?:_\d+)+$/.test(raw)) { return raw; }
	return /^\d+(?:\.\d+)+$/.test(raw) ? designerXmlVersionToMdSparrowFlag(raw) : undefined;
}
export class MetadataSourceProvider implements SourceProvider {
	readonly kind = 'metadata' as const;
	constructor(private readonly extensionContext: vscode.ExtensionContext) {}

	async enumerate(project: ProjectRef, selection: SourceSelection, token: vscode.CancellationToken): Promise<SourceInventory> {
		if (token.isCancellationRequested) {
			return { targets: [], revision: '', complete: false, errors: [{ code: 'cancelled', message: 'Отменено.', projectKey: project.key }] };
		}
		const targets: TargetDescriptor[] = [];
		const errors: CodeStyleError[] = [];
		let complete = true;
		let tree: ProjectMetadataTreeDto;
		const expectedRoots = sourceRoots(project).filter((root) =>
			root.kind === 'configuration' || root.kind === 'extension'
		);
		const noConfigurations = expectedRoots.length === 0;
		try {
			// A project containing only external artifacts cannot provide a configuration tree.
			tree = noConfigurations
				? fallbackExternals(project)
				: await loadProjectMetadataTree(this.extensionContext, project.root);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!project.layout.configuration && message.startsWith('Нет ни выгрузки конфигуратора')) {
				tree = fallbackExternals(project);
				if (!noConfigurations) {
					// md-sparrow did not enumerate extension metadata: report partial inventory.
					complete = false;
					errors.push({ code: 'metadataTreeIncomplete', projectKey: project.key, message });
				}
			} else {
				return { targets: [], revision: '', complete: false,
					errors: [{ code: 'metadataTreeFailed', message, projectKey: project.key }] };
			}
		}
		if (token.isCancellationRequested) {
			return { targets: [], revision: '', complete: false, errors: [{ code: 'cancelled', message: 'Отменено.', projectKey: project.key }] };
		}
		const treeRoots = new Set<string>();
		const push = async (descriptor: TargetDescriptor): Promise<void> => {
			const byFile = selection.files?.some((uri) => filePath(uri) !== undefined &&
				sameFile(filePath(uri)!, filePath(descriptor.uri) ?? '')) ?? false;
			const byKey = selection.targetKeys?.includes(descriptor.targetKey) ?? false;
			if ((selection.files || selection.targetKeys) && !byFile && !byKey) { return; }
			try {
				const file = filePath(descriptor.uri);
				const source = file && sourceForFile(project, file);
				if (!file || !source || descriptor.sourceKey !== source.key) {
					throw new Error('metadata-цель больше не принадлежит своему источнику.');
				}
				await ensureSafeFile(project, file, source);
				targets.push(descriptor);
			} catch (error) {
				complete = false;
				errors.push({ code: 'metadataTargetFailed', message: String(error), targetKey: descriptor.targetKey, projectKey: project.key });
			}
		};
		for (const treeSource of tree.sources) {
			if (token.isCancellationRequested) { complete = false; break; }
			if (treeSource.schemaSupported === false) {
				complete = false;
				errors.push({ code: 'metadataSchemaUnsupported', message: `Не поддерживается схема: ${treeSource.label}`, projectKey: project.key });
				// Unsupported is distinct from an absent source; do not synthesize a readable root.
				if (treeSource.configurationXmlRelativePath) {
					const unsupportedFile = path.resolve(project.root, treeSource.configurationXmlRelativePath);
					const matching = sourceByEntry(project, unsupportedFile);
					if (matching) { treeRoots.add(matching.key); }
				}
				continue;
			}
			let configFile: string | undefined;
			let rootSource: SourceRef | undefined;
			try {
				if (treeSource.configurationXmlRelativePath) {
					configFile = safePath(project, treeSource.configurationXmlRelativePath);
					rootSource = sourceByEntry(project, configFile) ?? sourceForFile(project, configFile);
				}
				if (configFile && rootSource && (rootSource.kind === 'configuration' || rootSource.kind === 'extension')) {
					treeRoots.add(rootSource.key);
					await push({
						projectKey: project.key, sourceKey: rootSource.key,
						targetKey: targetKeyOf(rootSource, this.kind, configFile),
						sourceKind: this.kind, uri: fileUri(configFile), sourceRoot: rootSource.root,
						format: rootSource.format, objectType: rootSource.kind === 'extension' ? 'ConfigurationExtension' : 'Configuration',
						name: treeSource.label, isSourceRoot: true,
						metadata: { configurationFile: configFile, objectFile: configFile,
							schemaVersion: schemaFlag(treeSource.schemaVersion),
							schemaSupported: treeSource.schemaSupported },
					});
				}
			} catch (error) {
				complete = false;
				errors.push({ code: 'metadataSourceFailed', message: String(error), projectKey: project.key });
			}
			for (const item of itemsOf(treeSource)) {
				try {
					const file = safePath(project, item.relativePath);
					const source = sourceForFile(project, file);
					if (!source) { throw new Error('Не найден корень metadata-объекта.'); }
					await push({
						projectKey: project.key, sourceKey: source.key,
						targetKey: targetKeyOf(source, this.kind, file), sourceKind: this.kind,
						uri: fileUri(file), sourceRoot: source.root, format: source.format,
						objectType: item.objectType, name: item.name,
						metadata: { configurationFile: configFile ?? source.entry, objectFile: file,
							schemaVersion: schemaFlag(treeSource.schemaVersion),
							schemaSupported: treeSource.schemaSupported },
					});
				} catch (error) {
					complete = false;
					errors.push({ code: 'metadataTargetFailed', message: String(error), projectKey: project.key });
				}
			}
		}
		// Never silently omit a recognized configuration/extension from the inventory.
		for (const root of expectedRoots) {
			const targetKey = targetKeyOf(root, this.kind, root.entry);
			if (treeRoots.has(root.key)) { continue; }
			complete = false;
			errors.push({ code: 'metadataRootNotEnumerated', projectKey: project.key,
				message: 'Дерево не содержит источник: ' + root.entry });
			await push({
				projectKey: project.key, sourceKey: root.key, targetKey, sourceKind: this.kind,
				uri: fileUri(root.entry), sourceRoot: root.root, format: root.format,
				objectType: root.kind === 'extension' ? 'ConfigurationExtension' : 'Configuration',
				isSourceRoot: true, name: path.basename(root.root),
				metadata: { configurationFile: root.entry, objectFile: root.entry },
			});
		}
		const byKey = new Map(targets.map((target) => [target.targetKey, target]));
		const sorted = [...byKey.values()].sort(targetCompare);
		return { targets: sorted, complete, errors, revision: stableHash(...sorted.map((target) => target.targetKey)) };
	}

	async read(project: ProjectRef, target: TargetDescriptor, token: vscode.CancellationToken): Promise<TargetSnapshot> {
		if (!target.metadata || target.metadata.schemaSupported === false) {
			throw new SourceDataError('unsupportedSource', 'metadata-цель не поддерживается.');
		}
		const file = filePath(target.uri);
		const source = file && sourceForFile(project, file);
		if (!file || !source || source.key !== target.sourceKey) { throw new Error('metadata-цель больше не принадлежит источнику.'); }
		await ensureSafeFile(project, file, source);
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		const version = await metadataFileVersion(file);
		const config = target.metadata.configurationFile;
		const isRoot = target.isSourceRoot === true;
		const flagFile = source.kind === 'processor' || source.kind === 'report' ? file : (isRoot ? file : config);
		const flag = target.metadata.schemaVersion ??
			await mdSparrowSchemaFlagFromConfigurationXml(flagFile);
		const params: MdSparrowParams = isRoot
			? { op: 'cf-configuration-properties-get', configurationXml: file, schemaVersion: flag }
			: { op: 'cf-md-object-get', objectXml: file, schemaVersion: flag };
		const runtime = await ensureMdSparrowRuntime(this.extensionContext, project.root);
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		const result = await runMdSparrowParamsRead(runtime, params, { cwd: project.root, token });
		if (token.isCancellationRequested) { throw new SourceDataError('cancelled', 'Операция отменена.'); }
		if (result.exitCode !== 0) { throw new Error(result.stderr.trim() || result.stdout.trim() || 'md-sparrow завершился с ошибкой.'); }
		if ((await metadataFileVersion(file)) !== version) { throw new Error('metadata-объект изменился во время чтения.'); }
		let dto: unknown;
		try { dto = JSON.parse(result.stdout) as unknown; }
		catch { throw new Error('md-sparrow вернул некорректный JSON.'); }
		return { kind: this.kind, uri: target.uri, version, dto };
	}
}
