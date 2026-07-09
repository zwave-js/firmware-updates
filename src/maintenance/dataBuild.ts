import JSON5 from "json5";
import crypto from "node:crypto";
import path from "path-browserify";
import { ConditionalUpdateConfig } from "../lib/config.js";
import { DataManifest, DataShard } from "../lib/dataFormat.js";
import type { FileSystem } from "../lib/fs/filesystem.js";
import { getErrorMessage, padVersion, versionToNumber } from "../lib/shared.js";

export interface ConfigFileEntry {
	filename: string;
	data: string;
}

export function isConfigFile(file: string): boolean {
	return (
		file.endsWith(".json") &&
		!file.endsWith("index.json") &&
		!path.basename(file).startsWith("_") &&
		!file.includes("/templates/") &&
		!file.includes("\\templates\\")
	);
}

/** Finds all config files below the given directory, sorted for deterministic output */
export async function discoverConfigFiles(
	fs: FileSystem,
	configDir: string,
): Promise<string[]> {
	return (await fs.readDir(configDir, true)).filter(isConfigFile).sort();
}

export async function readConfigFiles(
	fs: FileSystem,
	configDir: string,
): Promise<ConfigFileEntry[]> {
	const configFiles = await discoverConfigFiles(fs, configDir);

	const files: ConfigFileEntry[] = [];
	for (const filePath of configFiles) {
		const relativePath = path
			.relative(configDir, filePath)
			.replace(/\\/g, "/");
		const fileContent = await fs.readFile(filePath);
		files.push({ filename: relativePath, data: fileContent });
	}
	return files;
}

export function hashConfigFiles(files: ConfigFileEntry[]): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(files), "utf8")
		.digest("hex")
		.slice(0, 8);
}

/** Groups all config files into one shard per manufacturer ID. Throws on invalid config files. */
export function buildDataShards(
	files: ConfigFileEntry[],
): Map<string, DataShard> {
	const shards = new Map<string, DataShard>();

	for (const file of files) {
		let config: ConditionalUpdateConfig;
		try {
			config = new ConditionalUpdateConfig(JSON5.parse(file.data));
		} catch (e) {
			throw new Error(
				`Error parsing config file ${file.filename}: ${getErrorMessage(e)}`,
			);
		}

		const byManufacturer = Map.groupBy(
			config.devices,
			(d) => d.manufacturerId,
		);
		for (const [manufacturerId, devices] of byManufacturer) {
			let shard = shards.get(manufacturerId);
			if (!shard) {
				shard = { configs: [] };
				shards.set(manufacturerId, shard);
			}
			shard.configs.push({
				devices: devices.map((d) => ({
					productType: d.productType,
					productId: d.productId,
					min: versionToNumber(padVersion(d.firmwareVersion.min, "0")),
					max: versionToNumber(
						padVersion(d.firmwareVersion.max, "255"),
					),
				})),
				upgrades: config.upgrades,
			});
		}
	}

	return shards;
}

export function buildManifest(
	version: string,
	shards: Map<string, DataShard>,
): DataManifest {
	return {
		version,
		shards: [...shards.keys()].sort(),
	};
}
