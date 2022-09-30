import { createDurable } from "itty-durable";

interface RateLimit {
	resetDate: number;
	remaining: number;
}

const PERSIST_INTERVAL_MS = 10 * 1000;

export class RateLimiter extends createDurable() {
	private resetDate: number = 0;
	private remaining: number = 0;

	private lastPersist: number = 0;
	private persistTimeout: number | undefined;

	// Avoid persisting the values related to throttling the persist calls
	public getPersistable(): any {
		const { persistTimeout, ...persistable } = this;
		return persistable;
	}

	// private getStorage(): DurableObjectStorage {
	// 	return (this.state as any).storage;
	// }

	/**
	 * Checks if the current request is allowed. If not, returns the rate limit information.
	 */
	public async request(
		maxPerHour: number
	): Promise<RateLimit & { limitExceeded: boolean }> {
		const now = Date.now();

		// // Destroy the durable object if it hasn't been used for 2 hours
		// await this.getStorage().deleteAlarm();
		// await this.getStorage().setAlarm(now + 2 * 60 * 60 * 1000);

		if (this.resetDate < now) {
			// Not initialized yet or the rate limit has expired
			this.resetDate = now + 3600000;
			this.remaining = maxPerHour;
		}

		let limitExceeded = false;
		if (this.remaining > 0) {
			this.remaining = Math.max(0, this.remaining - 1);
		} else {
			limitExceeded = true;
		}

		await this.throttlePersist();

		return {
			resetDate: this.resetDate,
			remaining: this.remaining,
			limitExceeded,
		};
	}

	private async throttlePersist(): Promise<void> {
		// Persisting the state on every request is expensive. Instead we persist regularly after changes.
		// This has the risk of data loss if the worker crashes, or the DO gets evicted early, but that's acceptable for this use case.

		// (Re-)schedule a persist for later, so we automatically persist if nothing happens for a while
		if (this.persistTimeout == undefined) {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore - For some reason, the Node.JS globals end up in this file
			this.persistTimeout = setTimeout(() => {
				this.persistTimeout = undefined;
				console.log("throttlePersist: inside setTimeout cb");
				void this.doPersist();
			}, PERSIST_INTERVAL_MS);
		}

		// Also make sure to persist busy objects at least every PERSIST_INTERVAL_MS
		const now = Date.now();
		console.log(
			`throttlePersist: now = ${now}, lastPersist = ${
				this.lastPersist
			}, delta = ${now - this.lastPersist}`
		);
		if (
			this.lastPersist > 0 &&
			Date.now() - this.lastPersist > PERSIST_INTERVAL_MS
		) {
			// We haven't persisted in a while, so persist now
			await this.doPersist();
		}
	}

	private async doPersist(): Promise<void> {
		this.lastPersist = Date.now();
		await this.persist();
	}

	/** Refreshes the rate limiter and sets its remaining requests to the given value */
	public async setTo(maxPerHour: number): Promise<void> {
		this.resetDate = Date.now() + 3600000;
		this.remaining = maxPerHour;
		await this.doPersist();
	}

	// public async alarm(): Promise<void> {
	// 	await this.destroy();
	// }
}

export type RateLimiterProps = {
	RateLimiter: IttyDurableObjectNamespace<RateLimiter>;
};
