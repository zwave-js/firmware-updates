import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { DeviceIdentifier, UpgradeInfo, ConditionalUpgradeInfo } from "./configSchema";
import { FirmwareVersionRange, DeviceID, formatId, padVersion } from "./shared";
import { conditionApplies } from "./Logic";
import semver from "semver";

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
	device_id: number;
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

export async function getCurrentVersion(db: D1Database): Promise<string | undefined> {
	const result = await db
		.prepare("SELECT version FROM config_versions WHERE active = TRUE LIMIT 1")
		.first<{ version: string }>();
	
	return result?.version;
}

export async function setActiveVersion(db: D1Database, version: string): Promise<void> {
	// Disable all versions first, then enable the new one
	await db.batch([
		db.prepare("UPDATE config_versions SET active = FALSE WHERE active = TRUE"),
		db.prepare("INSERT OR REPLACE INTO config_versions (version, active) VALUES (?, TRUE)").bind(version)
	]);
}

export async function lookupConfigFromD1(
	db: D1Database,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string
): Promise<{ devices: DeviceIdentifier[], upgrades: ConditionalUpgradeInfo[] } | undefined> {
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

	// Get all upgrades for the matching devices
	const deviceIds = matchingDevices.map((d: DeviceRow) => d.id);
	const placeholders = deviceIds.map(() => '?').join(',');
	
	const upgradesQuery = `
		SELECT u.*, uf.target, uf.url, uf.integrity
		FROM upgrades u
		JOIN upgrade_files uf ON u.id = uf.upgrade_id
		WHERE u.device_id IN (${placeholders})
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
					device_id: row.device_id,
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

	// Convert upgrades and apply conditional filtering
	const upgrades: ConditionalUpgradeInfo[] = Array.from(upgradeMap.values())
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
		});

	return { devices: deviceIdentifiers, upgrades };
}

export async function insertConfigData(
	db: D1Database,
	version: string,
	configData: { devices: DeviceIdentifier[], upgrades: ConditionalUpgradeInfo[] }[]
): Promise<void> {
	const statements: D1PreparedStatement[] = [];

	// Insert or update the version record first
	statements.push(
		db.prepare("INSERT OR REPLACE INTO config_versions (version, active) VALUES (?, FALSE)").bind(version)
	);

	// Process each config file's data
	for (const config of configData) {
		const { devices, upgrades } = config;
		
		// Insert devices first
		for (const device of devices) {
			const deviceStmt = db.prepare(`
				INSERT INTO devices (
					version, brand, model, manufacturer_id, product_type, product_id,
					firmware_version_min, firmware_version_max
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				version,
				device.brand,
				device.model,
				device.manufacturerId,
				device.productType,
				device.productId,
				device.firmwareVersion.min,
				device.firmwareVersion.max
			);
			statements.push(deviceStmt);
		}
	}

	// Execute all device insertions first
	await db.batch(statements);

	// Now insert upgrades and files using a more efficient approach
	const upgradeStatements: D1PreparedStatement[] = [];
	const fileStatements: D1PreparedStatement[] = [];
	
	for (const config of configData) {
		const { devices, upgrades } = config;
		
		// For each device in this config, we need to insert its upgrades
		for (const device of devices) {
			// Get the device ID we just inserted by querying back
			const deviceIdResult = await db.prepare(`
				SELECT id FROM devices 
				WHERE version = ? AND manufacturer_id = ? AND product_type = ? AND product_id = ?
				AND firmware_version_min = ? AND firmware_version_max = ?
				ORDER BY id DESC LIMIT 1
			`).bind(
				version,
				device.manufacturerId,
				device.productType,
				device.productId,
				device.firmwareVersion.min,
				device.firmwareVersion.max
			).first<{ id: number }>();

			if (!deviceIdResult) continue;
			const deviceId = deviceIdResult.id;

			// Insert upgrades for this device
			for (const upgrade of upgrades) {
				const upgradeStmt = db.prepare(`
					INSERT INTO upgrades (
						device_id, version, firmware_version, changelog, channel, region, condition
					) VALUES (?, ?, ?, ?, ?, ?, ?)
				`).bind(
					deviceId,
					version,
					upgrade.version,
					upgrade.changelog,
					upgrade.channel,
					upgrade.region || null,
					upgrade.$if || null
				);
				upgradeStatements.push(upgradeStmt);
			}
		}
	}

	// Execute upgrade insertions
	if (upgradeStatements.length > 0) {
		await db.batch(upgradeStatements);
	}

	// Finally insert files for upgrades
	for (const config of configData) {
		const { devices, upgrades } = config;
		
		for (const device of devices) {
			const deviceIdResult = await db.prepare(`
				SELECT id FROM devices 
				WHERE version = ? AND manufacturer_id = ? AND product_type = ? AND product_id = ?
				AND firmware_version_min = ? AND firmware_version_max = ?
				ORDER BY id DESC LIMIT 1
			`).bind(
				version,
				device.manufacturerId,
				device.productType,
				device.productId,
				device.firmwareVersion.min,
				device.firmwareVersion.max
			).first<{ id: number }>();

			if (!deviceIdResult) continue;
			const deviceId = deviceIdResult.id;

			for (const upgrade of upgrades) {
				// Get the upgrade ID
				const upgradeIdResult = await db.prepare(`
					SELECT id FROM upgrades 
					WHERE device_id = ? AND version = ? AND firmware_version = ?
					ORDER BY id DESC LIMIT 1
				`).bind(
					deviceId,
					version,
					upgrade.version
				).first<{ id: number }>();

				if (!upgradeIdResult) continue;
				const upgradeId = upgradeIdResult.id;

				// Insert files for this upgrade
				for (const file of upgrade.files) {
					const fileStmt = db.prepare(`
						INSERT INTO upgrade_files (upgrade_id, target, url, integrity)
						VALUES (?, ?, ?, ?)
					`).bind(upgradeId, file.target, file.url, file.integrity);
					fileStatements.push(fileStmt);
				}
			}
		}
	}

	// Execute file insertions
	if (fileStatements.length > 0) {
		await db.batch(fileStatements);
	}
}

export async function deleteConfigVersion(db: D1Database, version: string): Promise<void> {
	// Delete the version and all related data (cascading deletes will handle the rest)
	await db.prepare("DELETE FROM config_versions WHERE version = ?").bind(version).run();
}

export async function listConfigVersions(db: D1Database): Promise<{ version: string, active: boolean, created_at: string }[]> {
	const result = await db.prepare("SELECT version, active, created_at FROM config_versions ORDER BY created_at DESC").all<{
		version: string;
		active: boolean;
		created_at: string;
	}>();
	
	return result.results || [];
}