import { withDurables } from "itty-durable";
import { json, type ThrowableRouter } from "itty-router-extras";
import { compare } from "semver";
import {
	APIv1v2_RequestSchema,
	APIv1_Response,
	APIv2_Response,
	APIv3_RequestSchema,
	APIv3_Response,
} from "../apiDefinitions";
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
	firmwareVersion: string,
	additionalFields: string[] = []
): string {
	if (!requestUrl.endsWith("/")) {
		requestUrl += "/";
	}
	const parts = [
		manufacturerId,
		productType,
		productId,
		firmwareVersion,
		...additionalFields,
	];
	return new URL(
		`./${parts.join(":")}?filesVersion=${filesVersion}`,
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
	resultTransform: ResultTransform,
	additionalFieldsForCacheKey: string[] = []
) {
	const result = await APIv1v2_RequestSchema.safeParseAsync(req.content);
	if (!result.success) {
		return clientError(result.error.format() as any);
	}
	const { manufacturerId, productType, productId, firmwareVersion } =
		result.data;

	const filesVersion = await getFilesVersion(
		req.url,
		context,
		env.CONFIG_FILES
	);

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
		firmwareVersion,
		additionalFieldsForCacheKey
	);

	let isUltraloq = false;
	if (
		manufacturerId === "0x0452" &&
		productType === "0x0004" &&
		productId === "0x0001"
	) {
		isUltraloq = true;
		console.log(`Got request for Ultraloq Lock. Cache key = ${cacheKey}`);
	}

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
					req.url,
					context,
					env.CONFIG_FILES,
					filesVersion
				),
				"/",
				manufacturerId,
				productType,
				productId,
				firmwareVersion
			);
			if (isUltraloq) {
				console.log(
					`Cache miss for Ultraloq Lock. Result = ${JSON.stringify(
						config
					)}`
				);
			}

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
							// Keep only stable releases (channel is v2 only)
							.filter((u) => u.channel === "stable")
							// Keep only updates without a region (v3 only)
							.filter((u) => !u.region)
							// Remove the channel and region property
							.map(({ channel, region, ...u }) => {
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
					return (
						upgrades
							// Keep only updates without a region (v3 only)
							.filter((u) => !u.region)
							// Remove the region property
							.map(({ region, ...u }) => {
								// Add missing fields to the returned objects
								const downgrade =
									compareVersions(
										u.version,
										firmwareVersion
									) < 0;
								let normalizedVersion = padVersion(u.version);
								if (u.channel === "beta")
									normalizedVersion += "-beta";

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
		"/api/v3/updates",
		async (
			req: RequestWithProps<[ContentProps]>,
			env: CloudflareEnvironment,
			context: ExecutionContext
		) => {
			// We need to filter non-matching regions here
			const result = await APIv3_RequestSchema.safeParseAsync(
				req.content
			);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}
			const { region } = result.data;

			return handleUpdateRequest(
				req,
				env,
				context,
				(upgrades, { firmwareVersion }): APIv3_Response => {
					// Rules for filtering updates by region:
					// - client specified no region -> return only updates without a region
					// - client specified a region -> return matching updates and updates without a region
					upgrades = upgrades.filter(
						(u) => !u.region || u.region === region
					);

					let ret: APIv3_Response = upgrades
						.map((u) => {
							// Add missing fields to the returned objects
							const downgrade =
								compareVersions(u.version, firmwareVersion) < 0;
							let normalizedVersion = padVersion(u.version);
							if (u.channel === "beta")
								normalizedVersion += "-beta";

							return {
								...u,
								downgrade,
								normalizedVersion,
							};
						})
						.sort((a, b) => {
							// Sort by version ascending...
							const ret = compare(
								a.normalizedVersion,
								b.normalizedVersion
							);
							if (ret !== 0) return ret;
							// ... and put updates for a specific region first
							return -(a.region ?? "").localeCompare(
								b.region ?? ""
							);
						});

					// If there are multiple updates for the same version, only return the first one
					// This happens when there are updates for a specific region and a general update for the same version
					ret = ret.filter((u, i, arr) => {
						if (i > 0 && u.version === arr[i - 1].version)
							return false;
						return true;
					});

					return ret;
				},
				region && [region]
			);
		}
	);
}
