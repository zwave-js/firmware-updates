import type { Fetcher } from "@cloudflare/workers-types";
import { APIv3_UpgradeInfo, APIv4_DeviceInfo } from "../apiDefinitions.js";
import {
	DataManifest,
	DataShard,
	getShardPath,
	MANIFEST_PATH,
} from "./dataFormat.js";
import { conditionApplies } from "./Logic.js";
import { formatId, padVersion, versionToNumber } from "./shared.js";

export interface DeviceLookupRequest {
	manufacturerId: number | string;
	productType: number | string;
	productId: number | string;
	firmwareVersion: string;
}

// Assets are immutable per deployment and isolates die on redeploy,
// so parsed data can be memoized for the isolate's lifetime
interface DataCache {
	manifest?: Promise<DataManifest | undefined>;
	shards: Map<string, Promise<DataShard | undefined>>;
}
const dataCaches = new WeakMap<Fetcher, DataCache>();

function getDataCache(assets: Fetcher): DataCache {
	let cache = dataCaches.get(assets);
	if (!cache) {
		cache = { shards: new Map() };
		dataCaches.set(assets, cache);
	}
	return cache;
}

async function fetchJSON<T>(
	assets: Fetcher,
	path: string,
): Promise<T | undefined> {
	// The assets binding only routes on the pathname, the origin is arbitrary
	const resp = await assets.fetch(`https://assets.local${path}`);
	// A missing asset is expected (unknown manufacturer), anything else is not
	if (resp.status === 404) return undefined;
	if (!resp.ok) {
		throw new Error(`Fetching asset ${path} failed with ${resp.status}`);
	}
	return (await resp.json()) as T;
}

function getManifest(assets: Fetcher): Promise<DataManifest | undefined> {
	const cache = getDataCache(assets);
	cache.manifest ??= fetchJSON<DataManifest>(assets, MANIFEST_PATH).then(
		(manifest) => {
			// Do not memoize failures, so a transient error heals on the next request
			if (!manifest || !Array.isArray(manifest.shards)) {
				cache.manifest = undefined;
				console.error("Data manifest is missing or malformed");
				return undefined;
			}
			return manifest;
		},
		(e) => {
			cache.manifest = undefined;
			console.error(`Failed to load data manifest: ${e}`);
			throw e;
		},
	);
	return cache.manifest;
}

async function getShard(
	assets: Fetcher,
	manufacturerId: string,
): Promise<DataShard | undefined> {
	const manifest = await getManifest(assets);
	if (!manifest?.shards.includes(manufacturerId)) return undefined;

	const cache = getDataCache(assets);
	let shard = cache.shards.get(manufacturerId);
	if (!shard) {
		shard = fetchJSON<DataShard>(assets, getShardPath(manufacturerId)).then(
			(result) => {
				if (!result) {
					cache.shards.delete(manufacturerId);
					// The manifest promised this shard, so this is a broken deployment
					console.error(
						`Shard ${manufacturerId} is listed in the manifest but missing`,
					);
				}
				return result;
			},
			(e) => {
				cache.shards.delete(manufacturerId);
				console.error(`Failed to load shard ${manufacturerId}: ${e}`);
				throw e;
			},
		);
		cache.shards.set(manufacturerId, shard);
	}
	return shard;
}

export async function getDataVersion(
	assets: Fetcher,
): Promise<string | undefined> {
	const manifest = await getManifest(assets);
	return manifest?.version;
}

export async function lookupConfigsBatch(
	assets: Fetcher,
	devices: DeviceLookupRequest[],
): Promise<APIv4_DeviceInfo[]> {
	const results: APIv4_DeviceInfo[] = [];

	// Load all needed shards in parallel before the sequential matching below
	const manufacturerIds = [
		...new Set(devices.map((d) => formatId(d.manufacturerId))),
	];
	const shardsById = new Map(
		await Promise.all(
			manufacturerIds.map(
				async (id) => [id, await getShard(assets, id)] as const,
			),
		),
	);

	for (const device of devices) {
		const manufacturerId = formatId(device.manufacturerId);
		const shard = shardsById.get(manufacturerId);
		if (!shard) continue;

		const productType = formatId(device.productType);
		const productId = formatId(device.productId);
		const firmwareVersion = padVersion(device.firmwareVersion, "0");
		const versionNumber = versionToNumber(firmwareVersion);

		const matchingConfigs = shard.configs.filter((config) =>
			config.devices.some(
				(d) =>
					d.productType === productType &&
					d.productId === productId &&
					versionNumber >= d.min &&
					versionNumber <= d.max,
			),
		);
		if (matchingConfigs.length === 0) continue;

		const deviceId = {
			manufacturerId: parseInt(manufacturerId, 16),
			productType: parseInt(productType, 16),
			productId: parseInt(productId, 16),
			firmwareVersion,
		};

		const updates = matchingConfigs
			.flatMap((config) => config.upgrades)
			.filter((upgrade) => conditionApplies(upgrade, deviceId))
			.map(({ $if, ...upgrade }): APIv3_UpgradeInfo => {
				return {
					version: upgrade.version,
					changelog: upgrade.changelog,
					channel: upgrade.channel,
					...(upgrade.region ? { region: upgrade.region } : {}),
					// Keep the key order the D1 path produced, for stable response bodies
					files: upgrade.files.map((f) => ({
						target: f.target,
						url: f.url,
						integrity: f.integrity,
					})),
					// These two will be filled in or filtered by the downstream handler
					downgrade: undefined as any,
					normalizedVersion: undefined as any,
				};
			});

		results.push({
			manufacturerId,
			productType,
			productId,
			firmwareVersion,
			updates,
		});
	}

	return results;
}

export async function lookupConfig(
	assets: Fetcher,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): Promise<APIv4_DeviceInfo | undefined> {
	const results = await lookupConfigsBatch(assets, [
		{
			manufacturerId,
			productType,
			productId,
			firmwareVersion,
		},
	]);
	return results[0];
}
