import type { RateLimit } from "@cloudflare/workers-types/experimental";
import { json, type ThrowableRouter } from "itty-router-extras";
import { compare } from "semver";
import {
	APIv1v2_RequestSchema,
	APIv1_Response,
	APIv2_Response,
	APIv3_RequestSchema,
	APIv3_Response,
	APIv4_DeviceInfo,
	APIv4_RequestSchema,
	APIv4_Response,
} from "../apiDefinitions.js";
import { withCache } from "../lib/cache.js";
import {
	cacheD1Config,
	getCurrentVersionCached,
	getD1CachedConfig,
} from "../lib/cachedD1Operations.js";
import type { UpgradeInfo } from "../lib/configSchema.js";
import {
	DeviceLookupRequest,
	lookupConfig,
	lookupConfigsBatch,
} from "../lib/d1Operations.js";
import { compareVersions, padVersion } from "../lib/shared.js";
import {
	clientError,
	ContentProps,
	serverError,
	type RequestWithProps,
} from "../lib/shared_cloudflare.js";
import { APIKeyProps, withAPIKey } from "../middleware/withAPIKey.js";
import type { CloudflareEnvironment } from "../worker.js";

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

	const filesVersion = await getCurrentVersionCached(
		req.url,
		context,
		env.CONFIG_FILES
	);
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
			const deviceInfo = await lookupConfig(
				env.CONFIG_FILES,
				filesVersion,
				manufacturerId,
				productType,
				productId,
				firmwareVersion
			);
			const updates = deviceInfo?.updates;
			if (!updates) return json([]);

			return json(
				resultTransform(updates, {
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
							// Filter out the current version
							.filter(
								(u) =>
									padVersion(u.version) !==
									padVersion(firmwareVersion)
							)
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
							// Filter out the current version
							.filter(
								(u) =>
									padVersion(u.version) !==
									padVersion(firmwareVersion)
							)
							// Remove the channel and region property
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
					// Filter out the current version
					upgrades = upgrades.filter(
						(u) =>
							padVersion(u.version) !==
							padVersion(firmwareVersion)
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

			const filesVersion = await getCurrentVersionCached(
				req.url,
				context,
				env.CONFIG_FILES
			);
			if (!filesVersion) {
				return serverError("Database empty");
			}

			// Remove duplicates, normalize and sort devices for consistent processing
			const uniqueDevices = devices
				.map((d) => {
					d.firmwareVersion = padVersion(d.firmwareVersion);
					return d;
				})
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

			// Step 1: Try to find cached responses for each unique device
			const cacheMisses: DeviceLookupRequest[] = [];
			const results: (APIv4_DeviceInfo | null)[] = [];

			for (const device of uniqueDevices) {
				// Try to get cached config for this device using D1 cache utilities
				const cachedConfig = await getD1CachedConfig(
					req.url,
					filesVersion,
					device.manufacturerId,
					device.productType,
					device.productId,
					device.firmwareVersion
				);

				if (cachedConfig !== undefined) {
					results.push(cachedConfig);
				} else {
					// Cache miss - add to batch lookup
					cacheMisses.push(device);
				}
			}

			// Step 2: Perform single batch request to database for all cache misses
			if (cacheMisses.length > 0) {
				const batchResults = await lookupConfigsBatch(
					env.CONFIG_FILES,
					filesVersion,
					cacheMisses
				);
				results.push(...batchResults);

				// Cache the results of the batch lookup
				for (const deviceInfo of batchResults) {
					await cacheD1Config(
						req.url,
						context,
						filesVersion,
						deviceInfo.manufacturerId,
						deviceInfo.productType,
						deviceInfo.productId,
						deviceInfo.firmwareVersion,
						deviceInfo
					);
				}
				// FIXME: Track which devices were NOT found in the DB and cache them as `null`
			}

			// Post-process the results to apply region filtering etc.
			// @ts-expect-error We still need to implement returning `null` for devices not in the DB
			const response: APIv4_Response = results.map((device) => {
				if (!device) return null;
				if (!device.updates) return device;
				let filteredUpgrades = device.updates
					// Filter out upgrades for a different region
					.filter((u) => !u.region || u.region === region)
					// Filter out the current version
					.filter(
						(u) =>
							padVersion(u.version) !==
							padVersion(device.firmwareVersion)
					)
					// Add missing fields to the returned objects

					.map((u: UpgradeInfo) => {
						const downgrade =
							compareVersions(u.version, device.firmwareVersion) <
							0;
						let normalizedVersion = u.version;
						if (u.channel === "beta") normalizedVersion += "-beta";

						return {
							...u,
							downgrade,
							normalizedVersion,
						};
					})
					// Sort by version ascending...
					.sort((a: any, b: any) => {
						const ret = compare(
							a.normalizedVersion,
							b.normalizedVersion
						);
						if (ret !== 0) return ret;
						// ... and put updates for a specific region first
						return -(a.region ?? "").localeCompare(b.region ?? "");
					});
				// If there are multiple updates for the same version, only return the first one
				// This happens when there are updates for a specific region and a general update for the same version
				filteredUpgrades = filteredUpgrades.filter(
					(u: any, i: number, arr: any[]) => {
						if (i > 0 && u.version === arr[i - 1].version)
							return false;
						return true;
					}
				);
				device.updates = filteredUpgrades;
				return device;
			});

			return json(response);
		}
	);
}
