import fs from "fs/promises";
import JSON5 from "json5";
import path from "path";
import semver from "semver";
import {
	ConditionalUpgradeInfo,
	configSchema,
	DeviceIdentifier,
	IConfig,
	UpgradeInfo,
} from "./configSchema";
import { conditionApplies } from "./Logic";
import {
	DeviceID,
	enumFilesRecursive,
	FirmwareVersionRange,
	formatId,
	padVersion,
} from "./shared";

export const configDir = path.join(__dirname, "../../firmwares");
let index: ConfigIndexEntry[] | undefined;

export class ConditionalUpdateConfig implements IConfig {
	public constructor(definition: any) {
		const { devices, upgrades } = configSchema.parse(definition);

		// Do some sanity checks

		// No upgrade should have duplicate targets
		for (let i = 0; i < upgrades.length; i++) {
			const upgrade = upgrades[i];
			const targets = new Set<number>();
			for (const file of upgrade.files) {
				if (targets.has(file.target)) {
					throw new Error(
						`Duplicate target ${file.target} in upgrades[${i}]`,
					);
				}
				targets.add(file.target);
			}
		}

		// No upgrade should have multiple files with the same URL
		for (let i = 0; i < upgrades.length; i++) {
			const upgrade = upgrades[i];
			const urls = new Set<string>();
			for (const file of upgrade.files) {
				if (urls.has(file.url)) {
					throw new Error(
						`Duplicate URL ${file.url} in upgrades[${i}]`,
					);
				}
				urls.add(file.url);
			}
		}

		this.devices = devices;
		this.upgrades = upgrades;
	}

	public readonly devices: DeviceIdentifier[];
	public readonly upgrades: ConditionalUpgradeInfo[];

	public evaluate(deviceId: DeviceID): UpdateConfig {
		return {
			devices: this.devices,
			upgrades: this.upgrades
				.filter((upgrade) => conditionApplies(upgrade, deviceId))
				.map(({ $if, ...upgrade }) => upgrade),
		};
	}
}

export interface UpdateConfig {
	readonly devices: readonly DeviceIdentifier[];
	readonly upgrades: readonly UpgradeInfo[];
}

async function generateIndexWorker<T extends Record<string, unknown>>(
	configDir: string,
	extractIndexEntries: (config: IConfig) => T[],
): Promise<(T & { filename: string })[]> {
	const index: (T & { filename: string })[] = [];

	const configFiles = await enumFilesRecursive(
		configDir,
		(file) =>
			file.endsWith(".json") &&
			!file.endsWith("index.json") &&
			!path.basename(file).startsWith("_") &&
			!file.includes("/templates/") &&
			!file.includes("\\templates\\"),
	);

	for (const file of configFiles) {
		const relativePath = path.relative(configDir, file).replace(/\\/g, "/");
		// Try parsing the file

		try {
			const fileContent = await fs.readFile(file, "utf8");
			const definition = JSON5.parse(fileContent);
			const config = new ConditionalUpdateConfig(definition);
			// Add the file to the index
			index.push(
				...extractIndexEntries(config).map((entry) => {
					const ret: T & { filename: string; rootDir?: string } = {
						...entry,
						filename: relativePath,
					};
					return ret;
				}),
			);
		} catch (e) {
			const message = `Error parsing config file ${relativePath}: ${
				(e as Error).message
			}`;
			// Crash hard during tests, just print an error when in production systems.
			// A user could have changed a config file
			if (process.env.NODE_ENV === "test" || !!process.env.CI) {
				throw new Error(message);
			} else {
				console.error(message);
			}
		}
	}

	return index;
}

export interface ConfigIndexEntry {
	manufacturerId: string;
	productType: string;
	productId: string;
	firmwareVersion: FirmwareVersionRange;
	filename: string;
}

export async function generateIndex(): Promise<ConfigIndexEntry[]> {
	const index: ConfigIndexEntry[] = await generateIndexWorker(
		configDir,
		(config) =>
			config.devices.map((dev) => ({
				manufacturerId: dev.manufacturerId,
				productType: dev.productType,
				productId: dev.productId,
				firmwareVersion: dev.firmwareVersion,
			})),
	);
	return index;
}

export async function loadIndex(): Promise<ConfigIndexEntry[]> {
	const indexFile = path.join(configDir, "index.json");
	const index = await fs.readFile(indexFile, "utf8");
	return JSON5.parse(index);
}

export function getConfigEntryPredicate(
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): (entry: ConfigIndexEntry) => boolean {
	return (entry) => {
		if (entry.manufacturerId !== formatId(manufacturerId)) return false;
		if (entry.productType !== formatId(productType)) return false;
		if (entry.productId !== formatId(productId)) return false;
		if (firmwareVersion != undefined) {
			// A firmware version was given, only look at files with a matching firmware version
			return (
				semver.lte(
					padVersion(entry.firmwareVersion.min),
					padVersion(firmwareVersion),
				) &&
				semver.gte(
					padVersion(entry.firmwareVersion.max),
					padVersion(firmwareVersion),
				)
			);
		}
		return true;
	};
}

export async function lookupConfig(
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): Promise<UpdateConfig | undefined> {
	index ??= await loadIndex();

	const entry = index.find(
		getConfigEntryPredicate(
			manufacturerId,
			productType,
			productId,
			firmwareVersion,
		),
	);
	if (!entry) return;

	// Try parsing the file
	try {
		const fileContent = await fs.readFile(
			path.join(configDir, entry.filename),
			"utf8",
		);
		const definition = JSON5.parse(fileContent);
		const ret = new ConditionalUpdateConfig(definition);

		// Un-stringify IDs so they can be compared
		const deviceId: DeviceID = {
			manufacturerId:
				typeof manufacturerId === "string"
					? parseInt(manufacturerId, 16)
					: manufacturerId,
			productType:
				typeof productType === "string"
					? parseInt(productType, 16)
					: productType,
			productId:
				typeof productId === "string"
					? parseInt(productId, 16)
					: productId,
			firmwareVersion,
		};

		return ret.evaluate(deviceId);
	} catch (e) {
		// Ignore and return nothing
		return;
	}
}
