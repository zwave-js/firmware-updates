import { withDurables } from "itty-durable";
import { json, type ThrowableRouter } from "itty-router-extras";
import {
	APIv1v2_RequestSchema,
	APIv1_Response,
	APIv2_Response,
} from "../apiV1V2";
import type { RateLimiterProps } from "../durable_objects/RateLimiter";
import { withCache } from "../lib/cache";
import { lookupConfig } from "../lib/config";
import type { UpgradeInfo } from "../lib/configSchema";
import { createCachedR2FS, getFilesVersion } from "../lib/fs/cachedR2FS";
import { compareVersions, padVersion } from "../lib/shared";
import {
	clientError,
	ContentProps,
	serverError,
	type RequestWithProps,
} from "../lib/shared_cloudflare";
import { APIKeyProps, withAPIKey } from "../middleware/withAPIKey";
import type { CloudflareEnvironment } from "../worker";

function getUpdatesCacheUrl(
	requestUrl: string,
	filesVersion: string,
	manufacturerId: string,
	productType: string,
	productId: string,
	firmwareVersion: string
): string {
	if (!requestUrl.endsWith("/")) {
		requestUrl += "/";
	}
	return new URL(
		`./${manufacturerId}:${productType}:${productId}:${firmwareVersion}?filesVersion=${filesVersion}`,
		requestUrl
	).toString();
}

type ResultTransform = (
	upgrades: readonly UpgradeInfo[],
	meta: {
		manufacturerId: string;
		productType: string;
		productId: string;
		firmwareVersion: string;
	}
) => any[];

async function handleUpdateRequest(
	req: RequestWithProps<[ContentProps]>,
	env: CloudflareEnvironment,
	context: ExecutionContext,
	resultTransform: ResultTransform
) {
	const result = await APIv1v2_RequestSchema.safeParseAsync(req.content);
	if (!result.success) {
		return clientError(result.error.format() as any);
	}
	const { manufacturerId, productType, productId, firmwareVersion } =
		result.data;

	const filesVersion = await getFilesVersion(context, env.CONFIG_FILES);

	if (!filesVersion) {
		return serverError("Filesystem empty");
	}

	// Figure out if this info is already cached
	const cacheKey = getUpdatesCacheUrl(
		req.url,
		filesVersion,
		manufacturerId,
		productType,
		productId,
		firmwareVersion
	);

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
				createCachedR2FS(context, env.CONFIG_FILES, filesVersion),
				"/",
				manufacturerId,
				productType,
				productId,
				firmwareVersion
			);

			if (!config) return json([]);

			return json(
				resultTransform(config.upgrades, {
					manufacturerId,
					productType,
					productId,
					firmwareVersion,
				})
			);
		}
	);
}

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

	// TODO: At some point we should combine the handlers for the v1 and v2 API
	router.post(
		"/api/v1/updates",
		(req: RequestWithProps<[ContentProps]>, env, context) =>
			handleUpdateRequest(
				req,
				env,
				context,
				(upgrades, { firmwareVersion }): APIv1_Response => {
					// API version 1 does not support release channels
					return (
						upgrades
							// Keep only stable releases
							.filter((u) => u.channel === "stable")
							// Remove the channel property
							.map(({ channel, ...u }) => {
								// Add missing fields to the returned objects
								const downgrade =
									compareVersions(
										u.version,
										firmwareVersion
									) < 0;
								const normalizedVersion = padVersion(u.version);

								return {
									...u,
									downgrade,
									normalizedVersion,
								};
							})
					);
				}
			)
	);

	router.post(
		"/api/v2/updates",
		(req: RequestWithProps<[ContentProps]>, env, context) =>
			handleUpdateRequest(
				req,
				env,
				context,
				(upgrades, { firmwareVersion }): APIv2_Response => {
					return upgrades.map((u) => {
						// Add missing fields to the returned objects
						const downgrade =
							compareVersions(u.version, firmwareVersion) < 0;
						let normalizedVersion = padVersion(u.version);
						if (u.channel === "beta") normalizedVersion += "-beta";

						return {
							...u,
							downgrade,
							normalizedVersion,
						};
					});
				}
			)
	);
}
