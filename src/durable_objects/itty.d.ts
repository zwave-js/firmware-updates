type PromisifyPublicFunctions<T> = {
	[K in keyof T]: T[K] extends (...args: any[]) => any
		? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>
		: never;
};

interface IttyDurableObjectNamespace<T> {
	get(id: string | DurableObjectId): PromisifyPublicFunctions<T>;
}
