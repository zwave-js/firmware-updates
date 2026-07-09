import type { ConditionalUpgradeInfo } from "./configSchema.js";

export const MANIFEST_PATH = "/manifest.json";

export interface DataManifest {
	/** Content hash of all config files, used as the cache key version */
	version: string;
	/** Manufacturer IDs (formatted as 0x1234) that have a shard file */
	shards: string[];
}

export interface ShardDeviceEntry {
	productType: string;
	productId: string;
	/** Inclusive firmware version range, normalized with versionToNumber */
	min: number;
	max: number;
}

/** Devices and upgrades from a single config file, limited to one manufacturer ID */
export interface ShardConfigEntry {
	devices: ShardDeviceEntry[];
	upgrades: ConditionalUpgradeInfo[];
}

export interface DataShard {
	configs: ShardConfigEntry[];
}

export function getShardPath(manufacturerId: string): string {
	return `/shards/${manufacturerId}.json`;
}
