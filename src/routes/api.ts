import { withDurables } from "itty-durable";
import { json, type ThrowableRouter } from "itty-router-extras";
import { APIv1_RequestSchema } from "../apiV1";
import type { RateLimiterProps } from "../durable_objects/RateLimiter";
import { lookupConfig } from "../lib/config";
import { createR2FS } from "../lib/fs/r2";
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
		env.timing = Date.now();
		const objId = env.RateLimiter.idFromName(
			(req.apiKey?.id ?? 0).toString()
		);
		const RateLimiter = req.RateLimiter.get(objId);

		env.logs.push(
			`[timing] took ${Date.now() - env.timing}ms to get RateLimiter`
		);
		env.timing = Date.now();

		const maxPerHour = req.apiKey?.rateLimit ?? 10000;
		const result = await RateLimiter.request(maxPerHour);

		env.logs.push(
			`[timing] took ${Date.now() - env.timing}ms to check RateLimiter`
		);
		env.timing = Date.now();

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
			env: CloudflareEnvironment
		) => {
			env.logs.push(
				`[timing] took ${
					Date.now() - env.timing!
				}ms to get to update route`
			);
			env.timing = Date.now();

			const result = await APIv1_RequestSchema.safeParseAsync(
				req.content
			);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}
			const { manufacturerId, productType, productId, firmwareVersion } =
				result.data;

			env.logs.push(
				`[timing] took ${Date.now() - env.timing}ms to parse request`
			);
			env.timing = Date.now();

			const versionFile = await env.CONFIG_FILES.get("version");
			env.logs.push(
				`[timing] took ${
					Date.now() - env.timing
				}ms to access version file`
			);
			env.timing = Date.now();

			const version = await versionFile?.text();

			env.logs.push(
				`[timing] took ${
					Date.now() - env.timing
				}ms to read version file`
			);
			env.timing = Date.now();

			if (!version) {
				return serverError("Filesystem empty");
			}

			const config = await lookupConfig(
				createR2FS(env.CONFIG_FILES, version),
				"/",
				manufacturerId,
				productType,
				productId,
				firmwareVersion
			);

			env.logs.push(
				`[timing] took ${Date.now() - env.timing}ms to lookup config`
			);
			env.timing = Date.now();

			// const config = undefined as any;
			if (!config) {
				// Config not found
				return json([]);
			}

			return json(config.upgrades);
		}
	);
}
