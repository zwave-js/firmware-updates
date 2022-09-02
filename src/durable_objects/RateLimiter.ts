import { createDurable } from "itty-durable";

interface RateLimit {
	resetDate: number;
	remaining: number;
}

export class RateLimiter extends createDurable() {
	private resetDate: number = 0;
	private remaining: number = 0;

	private getStorage(): DurableObjectStorage {
		return (this.state as any).storage;
	}

	/**
	 * Checks if the current request is allowed. If not, returns the rate limit information.
	 */
	public async request(
		maxPerHour: number
	): Promise<RateLimit & { limitExceeded: boolean }> {
		// Evict the durable object if it hasn't been used for 2 hours
		await this.getStorage().deleteAlarm();
		await this.getStorage().setAlarm(Date.now() + 2 * 60 * 60 * 1000);

		if (this.resetDate < Date.now()) {
			// Not initialized yet or the rate limit has expired
			this.resetDate = Date.now() + 3600000;
			this.remaining = maxPerHour;
		}

		let limitExceeded = false;
		if (this.remaining > 0) {
			this.remaining = Math.max(0, this.remaining - 1);
		} else {
			limitExceeded = true;
		}

		await this.persist();

		return {
			resetDate: this.resetDate,
			remaining: this.remaining,
			limitExceeded,
		};
	}

	public async alarm(): Promise<void> {
		await this.destroy();
	}
}

export type RateLimiterProps = {
	RateLimiter: IttyDurableObjectNamespace<RateLimiter>;
};
