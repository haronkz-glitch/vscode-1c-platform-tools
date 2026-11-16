import type { SourceKind, SourceProvider } from '../core/types';
export class SourceRegistry {
	private readonly providers = new Map<SourceKind, SourceProvider>();
	register(provider: SourceProvider): void {
		if (this.providers.has(provider.kind)) { throw new Error(`Поставщик ${provider.kind} уже зарегистрирован.`); }
		this.providers.set(provider.kind, provider);
	}
	get(kind: SourceKind): SourceProvider | undefined { return this.providers.get(kind); }
	list(): readonly SourceProvider[] { return [...this.providers.values()]; }
}
