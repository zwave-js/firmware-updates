import {
	configSchema,
	DeviceIdentifier,
	IConfig,
	UpgradeInfo,
} from "./configSchema";

export class UpdateConfig implements IConfig {
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
	public readonly upgrades: UpgradeInfo[];
}
