import type { RateLimit } from "@cloudflare/workers-types/experimental";
import { json, type ThrowableRouter } from "itty-router-extras";
import { compare } from "semver";
import {
	APIv1v2_RequestSchema,
	APIv1_Response,
	APIv2_Response,
	APIv3_RequestSchema,
	APIv3_Response,
	APIv4_RequestSchema,
	APIv4_Response,
} from "../apiDefinitions";
import { withCache } from "../lib/cache";
import type { UpgradeInfo } from "../lib/configSchema";
import { getCurrentVersion, lookupConfig } from "../lib/d1Operations";
import { array2hex, compareVersions, padVersion } from "../lib/shared";
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
	dbVersion: string,
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
		dbVersion,
		manufacturerId,
		productType,
		productId,
		firmwareVersion,
		...additionalFields,
	];
	return new URL(`./${parts.join("/")}`, requestUrl).toString();
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

	const filesVersion = await getCurrentVersion(env.CONFIG_FILES);
	if (!filesVersion) {
		return serverError("Database empty");
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

	return withCache(
		{
			req,
			context,
			cacheKey,
			// Cache for 1 hour on the client
			maxAge: 60 * 60,
			// Cache for 1 day on the server.
			// We use the database version as part of the cache key,
			// so we can safely cache for a longer time.
			sMaxAge: 60 * 60 * 24,
		},
		async () => {
			const config = await lookupConfig(
				env.CONFIG_FILES,
				filesVersion,
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

function getBucket(rateLimit: number): string {
	if (rateLimit === 9) return "TEST";
	if (rateLimit <= 100) return "FREE";
	if (rateLimit <= 1000) return "1k";
	if (rateLimit <= 10000) return "10k";
	if (rateLimit <= 100000) return "100k";
	return "FREE";
}

export default function register(router: ThrowableRouter): void {
	// Check API keys and apply rate limiter
	router.all("/api/*", withAPIKey, (async (
		req: RequestWithProps<[APIKeyProps]>,
		env: CloudflareEnvironment
	) => {
		const bucket =
			req.apiKey?.bucket ??
			(req.apiKey?.rateLimit && getBucket(req.apiKey.rateLimit)) ??
			"FREE";
		const rateLimiter = ((env as any)[`RL_${bucket}`] ??
			env.RL_FREE) as RateLimit;
		const apiKeyId = req.apiKey?.id ?? 0;

		const { success } = await rateLimiter.limit({
			key: apiKeyId.toString(),
		});

		if (!success) {
			// Rate limit exceeded

			return new Response(undefined, {
				status: 429,
				headers: {
					// Right now we have no way to know when the rate limit will reset
					"retry-after": "60",
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

	router.post(
		"/api/v4/updates",
		async (
			req: RequestWithProps<[ContentProps]>,
			env: CloudflareEnvironment,
			context: ExecutionContext
		) => {
			// Parse and validate the v4 request
			const result = await APIv4_RequestSchema.safeParseAsync(
				req.content
			);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}
			const { region, devices } = result.data;

			const filesVersion = await getCurrentVersion(env.CONFIG_FILES);
			if (!filesVersion) {
				return serverError("Database empty");
			}

			// Remove duplicates and sort devices for consistent cache key
			const uniqueDevices = devices
				.filter(
					(device, index, array) =>
						array.findIndex(
							(d) =>
								d.manufacturerId === device.manufacturerId &&
								d.productType === device.productType &&
								d.productId === device.productId &&
								d.firmwareVersion === device.firmwareVersion
						) === index
				)
				.sort((a, b) => {
					// Sort by manufacturerId, productType, productId, firmwareVersion
					if (a.manufacturerId !== b.manufacturerId) {
						return a.manufacturerId.localeCompare(b.manufacturerId);
					}
					if (a.productType !== b.productType) {
						return a.productType.localeCompare(b.productType);
					}
					if (a.productId !== b.productId) {
						return a.productId.localeCompare(b.productId);
					}
					return a.firmwareVersion.localeCompare(b.firmwareVersion);
				});

			// Create a unique cache key by hashing device information
			const encoder = new TextEncoder();
			const deviceHashes = await Promise.all(
				uniqueDevices.map(async (device) => {
					const parts = [
						filesVersion,
						device.manufacturerId,
						device.productType,
						device.productId,
						device.firmwareVersion,
						...(region ? [region] : []),
					];
					const hashInput = encoder.encode(parts.join("/"));
					const hash = new Uint8Array(
						await crypto.subtle.digest("SHA-256", hashInput)
					);
					return array2hex(hash);
				})
			);

			const finalHashInput = encoder.encode(deviceHashes.join("/"));
			const finalHashBuffer = new Uint8Array(
				await crypto.subtle.digest("SHA-256", finalHashInput)
			);
			const finalHash = array2hex(finalHashBuffer);

			let requestUrl = req.url;
			if (!requestUrl.endsWith("/")) {
				requestUrl += "/";
			}
			const cacheKey = new URL(
				`./bulk/${finalHash}`,
				requestUrl
			).toString();

			return withCache(
				{
					req,
					context,
					cacheKey,
					// Cache for 1 hour on the client
					maxAge: 60 * 60,
					// Cache for 1 day on the server.
					// We use the database version as part of the cache key,
					// so we can safely cache for a longer time.
					sMaxAge: 60 * 60 * 24,
				},
				async () => {
					const response: APIv4_Response = [];

					// Process each unique device
					for (const device of uniqueDevices) {
						const config = await lookupConfig(
							env.CONFIG_FILES,
							filesVersion,
							device.manufacturerId,
							device.productType,
							device.productId,
							device.firmwareVersion
						);

						let updates: APIv3_Response = [];

						if (config) {
							// Apply the same filtering logic as v3
							const filteredUpgrades = config.upgrades.filter(
								(u) => !u.region || u.region === region
							);

							updates = filteredUpgrades
								.map((u) => {
									// Add missing fields to the returned objects
									const downgrade =
										compareVersions(
											u.version,
											device.firmwareVersion
										) < 0;
									let normalizedVersion = padVersion(
										u.version
									);
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
							updates = updates.filter((u, i, arr) => {
								if (i > 0 && u.version === arr[i - 1].version)
									return false;
								return true;
							});
						}

						response.push({
							manufacturerId: device.manufacturerId,
							productType: device.productType,
							productId: device.productId,
							firmwareVersion: device.firmwareVersion,
							updates,
						});
					}

					return json(response);
				}
			);
		}
	);
}
