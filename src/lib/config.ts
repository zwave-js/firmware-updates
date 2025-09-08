import type { D1Database } from "@cloudflare/workers-types";
import {
	ConditionalUpgradeInfo,
	configSchema,
	DeviceIdentifier,
	IConfig,
	UpgradeInfo,
} from "./configSchema";
import { conditionApplies } from "./Logic";
import {
	compareVersions,
	DeviceID,
} from "./shared";
import { lookupConfigFromD1 } from "./d1Operations";

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
						`Duplicate target ${file.target} in upgrades[${i}]`
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
						`Duplicate URL ${file.url} in upgrades[${i}]`
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
				.filter(
					(upgrade) =>
						// Only return versions that are either an upgrade or a downgrade
						compareVersions(
							upgrade.version,
							deviceId.firmwareVersion
						) !== 0 && conditionApplies(upgrade, deviceId)
				)
				.map(({ $if, ...upgrade }) => upgrade),
		};
	}
}

export interface UpdateConfig {
	readonly devices: readonly DeviceIdentifier[];
	readonly upgrades: readonly UpgradeInfo[];
}

export async function lookupConfigD1(
	db: D1Database,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string
): Promise<UpdateConfig | undefined> {
	const result = await lookupConfigFromD1(
		db,
		manufacturerId,
		productType,
		productId,
		firmwareVersion
	);

	if (!result) return undefined;

	// Convert ConditionalUpgradeInfo to UpgradeInfo by removing $if conditions
	const upgrades: UpgradeInfo[] = result.upgrades.map(({ $if, ...upgrade }) => upgrade);

	return {
		devices: result.devices,
		upgrades
	};
}
