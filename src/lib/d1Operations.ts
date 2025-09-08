import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { DeviceIdentifier, UpgradeInfo, ConditionalUpgradeInfo } from "./configSchema";
import { FirmwareVersionRange, DeviceID, formatId, padVersion } from "./shared";
import { conditionApplies } from "./Logic";
import semver from "semver";

export interface UpdateConfig {
	readonly devices: readonly DeviceIdentifier[];
	readonly upgrades: readonly UpgradeInfo[];
}

// Types for D1 query results
interface DeviceRow {
	id: number;
	version: string;
	brand: string;
	model: string;
	manufacturer_id: string;
	product_type: string;
	product_id: string;
	firmware_version_min: string;
	firmware_version_max: string;
}

interface UpgradeRow {
	id: number;
	version: string;
	firmware_version: string;
	changelog: string;
	channel: string;
	region?: string;
	condition?: string;
}

interface UpgradeFileRow {
	id: number;
	upgrade_id: number;
	target: number;
	url: string;
	integrity: string;
}

export async function createConfigVersion(db: D1Database, version: string): Promise<void> {
	await db
		.prepare("INSERT OR REPLACE INTO config_versions (version, active) VALUES (?, FALSE)")
		.bind(version)
		.run();
}

export async function getCurrentVersion(db: D1Database): Promise<string | undefined> {
	const result = await db
		.prepare("SELECT version FROM config_versions WHERE active = TRUE LIMIT 1")
		.first<{ version: string }>();
	
	return result?.version;
}

export async function enableConfigVersion(db: D1Database, version: string): Promise<void> {
	// Disable all versions, enable the new one, then delete old inactive versions - all in one batch
	const statements: D1PreparedStatement[] = [
		// Disable all currently active versions
		db.prepare("UPDATE config_versions SET active = FALSE WHERE active = TRUE"),
		// Enable the new version
		db.prepare("UPDATE config_versions SET active = TRUE WHERE version = ?").bind(version),
		// Delete all inactive versions (cleanup old data)
		db.prepare("DELETE FROM config_versions WHERE active = FALSE AND version != ?").bind(version)
	];
	
	await db.batch(statements);
}

export async function lookupConfigFromD1(
	db: D1Database,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string
): Promise<UpdateConfig | undefined> {
	// Get the current active version
	const currentVersion = await getCurrentVersion(db);
	if (!currentVersion) {
		return undefined;
	}

	// Format IDs for query
	const formattedManufacturerId = formatId(manufacturerId);
	const formattedProductType = formatId(productType);
	const formattedProductId = formatId(productId);
	
	// Find matching devices
	const deviceQuery = `
		SELECT * FROM devices 
		WHERE version = ? 
		AND manufacturer_id = ? 
		AND product_type = ? 
		AND product_id = ?
	`;
	
	const devices = await db
		.prepare(deviceQuery)
		.bind(
			currentVersion,
			formattedManufacturerId,
			formattedProductType,
			formattedProductId
		)
		.all<DeviceRow>();

	if (!devices.results || devices.results.length === 0) {
		return undefined;
	}

	// Filter devices by firmware version using semver
	const matchingDevices = devices.results.filter((device: DeviceRow) => {
		return semver.lte(padVersion(device.firmware_version_min), padVersion(firmwareVersion)) &&
			   semver.gte(padVersion(device.firmware_version_max), padVersion(firmwareVersion));
	});

	if (matchingDevices.length === 0) {
		return undefined;
	}

	// Get all upgrades for the matching devices via the junction table
	const deviceIds = matchingDevices.map((d: DeviceRow) => d.id);
	const placeholders = deviceIds.map(() => '?').join(',');
	
	const upgradesQuery = `
		SELECT u.*, uf.target, uf.url, uf.integrity
		FROM device_upgrades du
		JOIN upgrades u ON du.upgrade_id = u.id
		JOIN upgrade_files uf ON u.id = uf.upgrade_id
		WHERE du.device_id IN (${placeholders})
		ORDER BY u.id, uf.target
	`;
	
	const upgradeResults = await db
		.prepare(upgradesQuery)
		.bind(...deviceIds)
		.all<UpgradeRow & UpgradeFileRow>();

	if (!upgradeResults.results) {
		return undefined;
	}

	// Group upgrade files by upgrade ID
	const upgradeMap = new Map<number, {
		upgrade: UpgradeRow,
		files: { target: number, url: string, integrity: string }[]
	}>();

	for (const row of upgradeResults.results) {
		if (!upgradeMap.has(row.id)) {
			upgradeMap.set(row.id, {
				upgrade: {
					id: row.id,
					version: row.version,
					firmware_version: row.firmware_version,
					changelog: row.changelog,
					channel: row.channel,
					region: row.region,
					condition: row.condition
				},
				files: []
			});
		}
		upgradeMap.get(row.id)!.files.push({
			target: row.target,
			url: row.url,
			integrity: row.integrity
		});
	}

	// Convert to the expected format
	const deviceIdentifiers: DeviceIdentifier[] = matchingDevices.map((device: DeviceRow) => ({
		brand: device.brand,
		model: device.model,
		manufacturerId: device.manufacturer_id,
		productType: device.product_type,
		productId: device.product_id,
		firmwareVersion: {
			min: device.firmware_version_min,
			max: device.firmware_version_max
		}
	}));

	// Create device ID for condition evaluation
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

	// Convert upgrades and apply conditional filtering, removing $if field
	const upgrades: UpgradeInfo[] = Array.from(upgradeMap.values())
		.map(({ upgrade, files }) => ({
			...(upgrade.condition && { $if: upgrade.condition }),
			version: upgrade.firmware_version,
			changelog: upgrade.changelog,
			channel: upgrade.channel as "stable" | "beta",
			...(upgrade.region && { region: upgrade.region as any }),
			files: files.map(f => ({
				target: f.target,
				url: f.url,
				integrity: f.integrity
			}))
		}))
		.filter(upgrade => {
			// Apply conditional logic if condition exists
			if (upgrade.$if) {
				return conditionApplies(upgrade, deviceId);
			}
			return true;
		})
		.map(({ $if, ...upgrade }) => upgrade); // Remove $if field from final result

	return { devices: deviceIdentifiers, upgrades };
}

export async function insertSingleConfigData(
	db: D1Database,
	version: string,
	config: { devices: DeviceIdentifier[], upgrades: ConditionalUpgradeInfo[] }
): Promise<void> {
	const { devices, upgrades } = config;
	
	// Insert devices and get their IDs using RETURNING
	const deviceIds: number[] = [];
	for (const device of devices) {
		const result = await db.prepare(`
			INSERT INTO devices (
				version, brand, model, manufacturer_id, product_type, product_id,
				firmware_version_min, firmware_version_max
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id
		`).bind(
			version,
			device.brand,
			device.model,
			device.manufacturerId,
			device.productType,
			device.productId,
			device.firmwareVersion.min,
			device.firmwareVersion.max
		).first<{ id: number }>();
		
		if (result) {
			deviceIds.push(result.id);
		}
	}

	// Insert upgrades and get their IDs using RETURNING
	const upgradeIds: number[] = [];
	for (const upgrade of upgrades) {
		const result = await db.prepare(`
			INSERT INTO upgrades (
				version, firmware_version, changelog, channel, region, condition
			) VALUES (?, ?, ?, ?, ?, ?)
			RETURNING id
		`).bind(
			version,
			upgrade.version,
			upgrade.changelog,
			upgrade.channel,
			upgrade.region || null,
			upgrade.$if || null
		).first<{ id: number }>();
		
		if (result) {
			upgradeIds.push(result.id);
		}
	}

	// Create device-upgrade relationships in the junction table
	const junctionStatements: D1PreparedStatement[] = [];
	for (const deviceId of deviceIds) {
		for (const upgradeId of upgradeIds) {
			junctionStatements.push(
				db.prepare(`
					INSERT INTO device_upgrades (device_id, upgrade_id) VALUES (?, ?)
				`).bind(deviceId, upgradeId)
			);
		}
	}
	
	if (junctionStatements.length > 0) {
		await db.batch(junctionStatements);
	}

	// Insert upgrade files
	const fileStatements: D1PreparedStatement[] = [];
	for (let i = 0; i < upgrades.length; i++) {
		const upgrade = upgrades[i];
		const upgradeId = upgradeIds[i];
		
		for (const file of upgrade.files) {
			fileStatements.push(
				db.prepare(`
					INSERT INTO upgrade_files (upgrade_id, target, url, integrity)
					VALUES (?, ?, ?, ?)
				`).bind(upgradeId, file.target, file.url, file.integrity)
			);
		}
	}
	
	if (fileStatements.length > 0) {
		await db.batch(fileStatements);
	}
}

export async function listConfigVersions(db: D1Database): Promise<{ version: string, active: boolean, created_at: string }[]> {
	const result = await db.prepare("SELECT version, active, created_at FROM config_versions ORDER BY created_at DESC").all<{
		version: string;
		active: boolean;
		created_at: string;
	}>();
	
	return result.results || [];
}