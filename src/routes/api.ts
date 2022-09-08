import { withDurables } from "itty-durable";
import { json, type ThrowableRouter } from "itty-router-extras";
import { APIv1_RequestSchema } from "../apiV1";
import type { RateLimiterProps } from "../durable_objects/RateLimiter";
import { withCache } from "../lib/cache";
import { lookupConfig } from "../lib/config";
import { createCachedR2FS, getFilesVersion } from "../lib/fs/cachedR2FS";
import {
	clientError,
	ContentProps,
	serverError,
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
		const objId = env.RateLimiter.idFromName(
			(req.apiKey?.id ?? 0).toString()
		);
		const RateLimiter = req.RateLimiter.get(objId);

		const maxPerHour = req.apiKey?.rateLimit ?? 10000;
		const result = await RateLimiter.request(maxPerHour);

		env.responseHeaders = {
			...env.responseHeaders,
			"x-ratelimit-limit": maxPerHour.toString(),
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
			env: CloudflareEnvironment,
			context: ExecutionContext
		) => {
			const result = await APIv1_RequestSchema.safeParseAsync(
				req.content
			);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}
			const { manufacturerId, productType, productId, firmwareVersion } =
				result.data;

			const version = await getFilesVersion(
				env.CONFIG_FILES,
				env.R2_CACHE
			);

			if (!version) {
				return serverError("Filesystem empty");
			}

			// Figure out if this info is already cached
			const cacheUrl = new URL(
				`/${manufacturerId}:${productType}:${productId}:${firmwareVersion}?version=${version}`,
				req.url
			);
			const cacheKey = cacheUrl.toString();

			return withCache(
				{
					req,
					context,
					cacheKey,
					// Cache for 1 hour on the client
					maxAge: 60 * 60,
					// Cache for 1 day on the server.
					// We use the file hash/revision as part of the cache key,
					// so we can safely cache for a longer time.
					sMaxAge: 60 * 60 * 24,
				},
				async () => {
					const config = await lookupConfig(
						createCachedR2FS(
							env.CONFIG_FILES,
							env.R2_CACHE,
							version
						),
						"/",
						manufacturerId,
						productType,
						productId,
						firmwareVersion
					);

					return json(config?.upgrades ?? []);
				}
			);
		}
	);
}
