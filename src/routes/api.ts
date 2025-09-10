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
import {
	cacheD1Config,
	getCurrentVersionCached,
	getD1CachedConfig,
} from "../lib/cachedD1Operations";
import type { UpgradeInfo } from "../lib/configSchema";
import { DeviceRow, lookupConfig } from "../lib/d1Operations";
import {
	compareVersions,
	formatId,
	padVersion,
	versionToNumber,
} from "../lib/shared";
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

			const response: APIv4_Response = [];

			// Step 1: Try to find cached responses for each unique device
			const cacheMisses: typeof uniqueDevices = [];
			const cachedResults = new Map<string, any>();

			for (const device of uniqueDevices) {
				const deviceKey = `${device.manufacturerId}:${device.productType}:${device.productId}:${device.firmwareVersion}`;

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
					cachedResults.set(deviceKey, cachedConfig);
				} else {
					// Cache miss - add to batch lookup
					cacheMisses.push(device);
				}
			}

			// Step 2: Perform single batch request to database for all cache misses
			const batchResults = new Map<string, any>();

			if (cacheMisses.length > 0) {
				// Use D1 batch to query all devices at once
				const batchQueries = cacheMisses.map((device) => {
					return env.CONFIG_FILES.prepare(
						`
							SELECT * FROM devices 
							WHERE version = ? 
							AND manufacturer_id = ? 
							AND product_type = ? 
							AND product_id = ?
							AND ? BETWEEN firmware_version_min_normalized AND firmware_version_max_normalized
							LIMIT 1
						`
					).bind(
						filesVersion,
						formatId(device.manufacturerId),
						formatId(device.productType),
						formatId(device.productId),
						versionToNumber(device.firmwareVersion)
					);
				});

				// Execute batch query
				const batchDeviceResults =
					await env.CONFIG_FILES.batch<DeviceRow>(batchQueries);

				// Process each device result
				for (let i = 0; i < cacheMisses.length; i++) {
					const device = cacheMisses[i];
					const deviceKey = `${device.manufacturerId}:${device.productType}:${device.productId}:${device.firmwareVersion}`;
					const deviceResult = batchDeviceResults[i];

					if (
						deviceResult.success &&
						deviceResult.results &&
						deviceResult.results.length > 0
					) {
						// Take the first (and should be only) matching device since we filtered in SQL
						const matchingDevice = deviceResult.results[0]!;

						// Get upgrades for this device
						const upgradesResult = await env.CONFIG_FILES.prepare(
							`
									SELECT u.*, uf.target, uf.url, uf.integrity
									FROM device_upgrades du
									JOIN upgrades u ON du.upgrade_id = u.id
									JOIN upgrade_files uf ON u.id = uf.upgrade_id
									WHERE du.device_id = ?
									ORDER BY u.id, uf.target
								`
						)
							.bind((matchingDevice as any).id)
							.all();

						if (upgradesResult.success && upgradesResult.results) {
							// Group files that belong to a single upgrade
							const upgradeMap = new Map<number, any>();

							for (const row of upgradesResult.results) {
								const rowData = row as any;
								if (!upgradeMap.has(rowData.id)) {
									upgradeMap.set(rowData.id, {
										upgrade: {
											id: rowData.id,
											firmware_version:
												rowData.firmware_version,
											changelog: rowData.changelog,
											channel: rowData.channel,
											region: rowData.region,
											condition: rowData.condition,
										},
										files: [],
									});
								}
								upgradeMap.get(rowData.id)!.files.push({
									target: rowData.target,
									url: rowData.url,
									integrity: rowData.integrity,
								});
							}

							// Create device identifiers and upgrades
							const deviceIdentifiers = [
								{
									brand: (matchingDevice as any).brand,
									model: (matchingDevice as any).model,
									manufacturerId: (matchingDevice as any)
										.manufacturer_id,
									productType: (matchingDevice as any)
										.product_type,
									productId: (matchingDevice as any)
										.product_id,
									firmwareVersion: {
										min: (matchingDevice as any)
											.firmware_version_min,
										max: (matchingDevice as any)
											.firmware_version_max,
									},
								},
							];

							// FIXME: THis seems overly complicated for only potentially deleting the region field
							const upgrades = Array.from(
								upgradeMap.values()
							).map(({ upgrade, files }) => ({
								version: upgrade.firmware_version,
								changelog: upgrade.changelog,
								channel: upgrade.channel as "stable" | "beta",
								...(upgrade.region && {
									region: upgrade.region,
								}),
								files: files.map((f: any) => ({
									target: f.target,
									url: f.url,
									integrity: f.integrity,
								})),
							}));

							const config = {
								devices: deviceIdentifiers,
								upgrades,
							};
							batchResults.set(deviceKey, config);
						}
					}

					// If no config found, set null
					if (!batchResults.has(deviceKey)) {
						batchResults.set(deviceKey, null);
					}

					// Step 3: Cache each entry individually using D1 cache utilities
					// Cache both successful lookups and null results (device not found/no updates)
					const configToCache = batchResults.get(deviceKey);
					await cacheD1Config(
						req.url,
						context,
						filesVersion,
						device.manufacturerId,
						device.productType,
						device.productId,
						device.firmwareVersion,
						configToCache
					);
				}
			}

			// Process each unique device using cached and batch results
			for (const device of uniqueDevices) {
				const deviceKey = `${device.manufacturerId}:${device.productType}:${device.productId}:${device.firmwareVersion}`;
				const config =
					cachedResults.get(deviceKey) || batchResults.get(deviceKey);

				let updates: APIv3_Response = [];

				// null indicates no updates
				if (config) {
					const filteredUpgrades = (config.upgrades as UpgradeInfo[])
						// Filter out upgrades for a different region
						.filter((u) => !u.region || u.region === region)
						// Filter out the current version
						.filter(
							(u) =>
								padVersion(u.version) !==
								padVersion(device.firmwareVersion)
						);

					updates = filteredUpgrades
						.map((u: UpgradeInfo) => {
							// Add missing fields to the returned objects
							const downgrade =
								compareVersions(
									u.version,
									device.firmwareVersion
								) < 0;
							let normalizedVersion = u.version;
							if (u.channel === "beta")
								normalizedVersion += "-beta";

							return {
								...u,
								downgrade,
								normalizedVersion,
							};
						})
						.sort((a: any, b: any) => {
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
					updates = updates.filter(
						(u: any, i: number, arr: any[]) => {
							if (i > 0 && u.version === arr[i - 1].version)
								return false;
							return true;
						}
					);
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
