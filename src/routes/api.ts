import { withDurables } from "itty-durable";
import { json, type ThrowableRouter } from "itty-router-extras";
import { APIv1_RequestSchema } from "../apiV1";
import type { RateLimiterProps } from "../durable_objects/RateLimiter";
import { lookupConfig } from "../lib/config";
import { createR2FS } from "../lib/fs/r2";
import {
	clientError,
	ContentProps,
	type RequestWithProps,
} from "../lib/shared";
import { APIKeyProps, withAPIKey } from "../middleware/withAPIKey";
import type { CloudflareEnvironment } from "../worker";

export default function register(router: ThrowableRouter): void {
	// Check API keys and apply rate limiter
	router.all("/api/*", withAPIKey, withDurables({ parse: true }), (async (
		req: RequestWithProps<[APIKeyProps, RateLimiterProps]>,
		env: CloudflareEnvironment
	) => {
		const RateLimiter = req.RateLimiter.get("_default");

		const result = await RateLimiter.request(
			req.apiKey?.id ?? 0,
			req.apiKey?.rateLimit ?? 3
		);

		env.responseHeaders = {
			...env.responseHeaders,
			"x-ratelimit-limit": result.maxPerHour.toString(),
			"x-ratelimit-remaining": result.remaining.toString(),
			"x-ratelimit-reset": Math.ceil(result.resetDate / 1000).toString(),
		};

		if (result.limitExceeded) {
			// Rate limit exceeded
			return new Response(undefined, {
				status: 429,
				headers: {
					"retry-after": Math.ceil(
						(result.resetDate - Date.now()) / 1000
					).toString(),
				},
			});
		}
	}) as any);

	router.post(
		"/api/v1/updates",
		async (
			req: RequestWithProps<[ContentProps]>,
			env: CloudflareEnvironment
		) => {
			const result = await APIv1_RequestSchema.safeParseAsync(
				req.content
			);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}
			const { manufacturerId, productType, productId, firmwareVersion } =
				result.data;

			const config = await lookupConfig(
				createR2FS(env.CONFIG_FILES),
				"/",
				manufacturerId,
				productType,
				productId,
				firmwareVersion
			);
			// const config = undefined as any;
			if (!config) {
				// Config not found
				return json([]);
			}

			return json(config.upgrades);
		}
	);
}
