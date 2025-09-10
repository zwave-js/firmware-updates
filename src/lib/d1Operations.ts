import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import { APIv3_UpgradeInfo, APIv4_DeviceInfo } from "../apiDefinitions.js";
import type {
	ConditionalUpgradeInfo,
	DeviceIdentifier,
} from "./configSchema.js";
import { conditionApplies } from "./Logic.js";
import { formatId, padVersion, versionToNumber } from "./shared.js";

// Schema for the joined device + upgrade + file query result
export interface UpgradesQueryRow {
	// devices table
	brand: string;
	model: string;
	manufacturer_id: string;
	product_type: string;
	product_id: string;
	firmware_version: string;
	firmware_version_min: string;
	firmware_version_max: string;
	firmware_version_min_normalized: number;
	firmware_version_max_normalized: number;

	// upgrades table
	upgrade_id: number;
	upgrade_firmware_version: string;
	changelog: string;
	channel: string;
	region: string | null;
	condition: string | null;

	// upgrade_files table
	target: number;
	url: string;
	integrity: string;
}

export async function createConfigVersion(
	db: D1Database,
	version: string,
): Promise<void> {
	await db
		.prepare(
			"INSERT OR REPLACE INTO config_versions (version, active) VALUES (?, FALSE)",
		)
		.bind(version)
		.run();
}

export async function getCurrentVersion(
	db: D1Database,
): Promise<string | undefined> {
	const result = await db
		.prepare(
			"SELECT version FROM config_versions WHERE active = TRUE LIMIT 1",
		)
		.first<{ version: string }>();

	return result?.version;
}

export async function enableConfigVersion(
	db: D1Database,
	version: string,
): Promise<void> {
	// Disable all versions, enable the new one, then delete old inactive versions - all in one batch
	const statements: D1PreparedStatement[] = [
		// Disable all currently active versions
		db.prepare(
			"UPDATE config_versions SET active = FALSE WHERE active = TRUE",
		),
		// Enable the new version
		db
			.prepare(
				"UPDATE config_versions SET active = TRUE WHERE version = ?",
			)
			.bind(version),
		// Delete all inactive versions (cleanup old data)
		db
			.prepare(
				"DELETE FROM config_versions WHERE active = FALSE AND version != ?",
			)
			.bind(version),
	];

	await db.batch(statements);
}

export interface DeviceLookupRequest {
	manufacturerId: number | string;
	productType: number | string;
	productId: number | string;
	firmwareVersion: string;
}

// D1 has a limit of 100 variables per query
// We use 5 variables per device + 1 for version = max 19 devices per chunk
const D1_MAX_VARIABLES = 100;
const VARIABLES_PER_DEVICE = 5;
const CHUNK_SIZE = Math.floor((D1_MAX_VARIABLES - 1) / VARIABLES_PER_DEVICE); // -1 for version variable

async function lookupConfigsChunk(
	db: D1Database,
	filesVersion: string,
	devices: DeviceLookupRequest[],
): Promise<UpgradesQueryRow[]> {
	// Build device conditions and bind parameters for the query
	const bindParams: any[] = [];

	for (const device of devices) {
		bindParams.push(
			formatId(device.manufacturerId),
			formatId(device.productType),
			formatId(device.productId),
			padVersion(device.firmwareVersion, "0"),
			versionToNumber(device.firmwareVersion),
		);
	}

	// Single query to get all devices and their upgrades
	const query = `
		WITH fingerprints(manufacturer_id, product_type, product_id, firmware_version, firmware_version_normalized) AS (
			VALUES
				${devices.map(() => `(?, ?, ?, ?, ?)`).join(",")}
		)
		SELECT 
			d.brand,
			d.model, 
			d.manufacturer_id,
			d.product_type,
			d.product_id,
			f.firmware_version,
			d.firmware_version_min,
			d.firmware_version_max,
			d.firmware_version_min_normalized,
			d.firmware_version_max_normalized,
			u.id as upgrade_id,
			u.firmware_version as upgrade_firmware_version,
			u.changelog,
			u.channel,
			u.region,
			u.condition,
			uf.target,
			uf.url,
			uf.integrity
		FROM fingerprints f
		JOIN devices d
		  ON d.manufacturer_id = f.manufacturer_id
		  AND d.product_type = f.product_type
		  AND d.product_id = f.product_id
		  AND f.firmware_version_normalized BETWEEN d.firmware_version_min_normalized AND d.firmware_version_max_normalized
		LEFT JOIN device_upgrades du ON d.id = du.device_id
		LEFT JOIN upgrades u ON du.upgrade_id = u.id  
		LEFT JOIN upgrade_files uf ON u.id = uf.upgrade_id
		WHERE d.version = ?
		ORDER BY d.id, u.id, uf.target
	`;

	bindParams.push(filesVersion);

	const queryResults = await db
		.prepare(query)
		.bind(...bindParams)
		.all<UpgradesQueryRow>();

	return queryResults.results;
}

export async function lookupConfigsBatch(
	db: D1Database,
	filesVersion: string,
	devices: DeviceLookupRequest[],
): Promise<APIv4_DeviceInfo[]> {
	if (devices.length === 0) return [];

	// Process devices in chunks to avoid D1's variable limit
	const allResults: UpgradesQueryRow[] = [];

	for (let i = 0; i < devices.length; i += CHUNK_SIZE) {
		const chunk = devices.slice(i, i + CHUNK_SIZE);
		const chunkResults = await lookupConfigsChunk(db, filesVersion, chunk);
		allResults.push(...chunkResults);
	}

	// Group rows by device ID
	return Map.groupBy(
		allResults,
		(row) =>
			`${row.manufacturer_id}:${row.product_type}:${row.product_id}:${row.firmware_version}`,
	)
		.values()
		.map((deviceRows) => {
			// All rows in each deviceRows array are for the same device. They are essentially an expansion device x upgrades x files
			const deviceRow = deviceRows[0];
			const deviceId = {
				manufacturerId: parseInt(deviceRow.manufacturer_id, 16),
				productType: parseInt(deviceRow.product_type, 16),
				productId: parseInt(deviceRow.product_id, 16),
				firmwareVersion: deviceRow.firmware_version,
			};

			const updates = Map.groupBy(deviceRows, (row) => row.upgrade_id)
				.values()
				// All rows in each upgradeRows array are for the same upgrade. They are essentially an expansion upgrade x files
				.filter((upgradeRows) => {
					const upgrade = upgradeRows[0];
					// Apply conditional logic if condition exists
					if (upgrade.condition) {
						return conditionApplies(
							{ $if: upgrade.condition, ...upgrade },
							deviceId,
						);
					}
					return true;
				})
				.map((upgradeRows) => {
					const upgradeRow = upgradeRows[0];
					const upgrade: APIv3_UpgradeInfo = {
						version: upgradeRow.upgrade_firmware_version,
						changelog: upgradeRow.changelog,
						channel: upgradeRow.channel as "stable" | "beta",
						...(upgradeRow.region
							? { region: upgradeRow.region as any }
							: {}),
						files: upgradeRows.map((file) => ({
							target: file.target,
							url: file.url,
							integrity: file.integrity,
						})),
						// These two will be filled in or filtered by the downstream handler
						downgrade: undefined as any,
						normalizedVersion: undefined as any,
					};
					return upgrade;
				})
				.toArray();

			const device: APIv4_DeviceInfo = {
				manufacturerId: deviceRow.manufacturer_id,
				productType: deviceRow.product_type,
				productId: deviceRow.product_id,
				firmwareVersion: deviceRow.firmware_version,
				updates,
			};

			return device;
		})
		.toArray();
}

export async function lookupConfig(
	db: D1Database,
	filesVersion: string,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): Promise<APIv4_DeviceInfo | undefined> {
	const results = await lookupConfigsBatch(db, filesVersion, [
		{
			manufacturerId,
			productType,
			productId,
			firmwareVersion,
		},
	]);
	return results[0];
}

export async function insertSingleConfigData(
	db: D1Database,
	version: string,
	config: { devices: DeviceIdentifier[]; upgrades: ConditionalUpgradeInfo[] },
): Promise<void> {
	const { devices, upgrades } = config;

	// Insert devices and get their IDs
	const deviceIds: number[] = [];
	for (const device of devices) {
		const firmwareVersionMin = padVersion(device.firmwareVersion.min, "0");
		const firmwareVersionMax = padVersion(
			device.firmwareVersion.max,
			"255",
		);
		const minVersionNormalized = versionToNumber(firmwareVersionMin);
		const maxVersionNormalized = versionToNumber(firmwareVersionMax);

		const result = await db
			.prepare(
				`
			INSERT INTO devices (
				version, brand, model, manufacturer_id, product_type, product_id,
				firmware_version_min, firmware_version_max,
				firmware_version_min_normalized, firmware_version_max_normalized
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id
		`,
			)
			.bind(
				version,
				device.brand,
				device.model,
				device.manufacturerId,
				device.productType,
				device.productId,
				firmwareVersionMin,
				firmwareVersionMax,
				minVersionNormalized,
				maxVersionNormalized,
			)
			.first<{ id: number }>();

		if (result) {
			deviceIds.push(result.id);
		}
	}

	// Insert upgrades and get their IDs
	const upgradeIds: number[] = [];
	for (const upgrade of upgrades) {
		const result = await db
			.prepare(
				`
			INSERT INTO upgrades (
				firmware_version, changelog, channel, region, condition
			) VALUES (?, ?, ?, ?, ?)
			RETURNING id
		`,
			)
			.bind(
				upgrade.version,
				upgrade.changelog,
				upgrade.channel,
				upgrade.region || null,
				upgrade.$if || null,
			)
			.first<{ id: number }>();

		if (result) {
			upgradeIds.push(result.id);
		}
	}

	// Create device-upgrade relationships in the junction table
	const junctionStatements: D1PreparedStatement[] = [];
	for (const deviceId of deviceIds) {
		for (const upgradeId of upgradeIds) {
			junctionStatements.push(
				db
					.prepare(
						`
					INSERT INTO device_upgrades (device_id, upgrade_id) VALUES (?, ?)
				`,
					)
					.bind(deviceId, upgradeId),
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
				db
					.prepare(
						`
					INSERT INTO upgrade_files (upgrade_id, target, url, integrity)
					VALUES (?, ?, ?, ?)
				`,
					)
					.bind(upgradeId, file.target, file.url, file.integrity),
			);
		}
	}

	if (fileStatements.length > 0) {
		await db.batch(fileStatements);
	}
}
