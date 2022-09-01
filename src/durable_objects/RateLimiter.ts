import { createDurable } from "itty-durable";

interface RateLimit {
	resetDate: number;
	maxPerHour: number;
	remaining: number;
}

export class RateLimiter extends createDurable() {
	public limits: Map<number, RateLimit> = new Map();

	/**
	 * Checks if the current request is allowed. If not, returns the rate limit information.
	 */
	public request(
		id: number,
		maxPerHour: number
	): RateLimit & { limitExceeded: boolean } {
		if (!this.limits.has(id)) {
			this.limits.set(id, {
				resetDate: Date.now() + 10000,
				maxPerHour,
				remaining: maxPerHour,
			});
		}
		const limit = this.limits.get(id)!;
		if (limit.resetDate < Date.now()) {
			// Reset limits first, the window has elapsed
			limit.remaining = limit.maxPerHour;
			limit.resetDate = Date.now() + 10000;
		}

		let limitExceeded = false;
		if (limit.remaining > 0) {
			limit.remaining = Math.max(0, limit.remaining - 1);
		} else {
			limitExceeded = true;
		}
		return { ...limit, limitExceeded };
	}
}

export type RateLimiterProps = {
	RateLimiter: IttyDurableObjectNamespace<RateLimiter>;
};
