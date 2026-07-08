import JSON5 from "json5";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "path-browserify";
import { ConditionalUpdateConfig } from "../lib/config.js";
import {
	DataManifest,
	DataShard,
	getShardPath,
	MANIFEST_PATH,
} from "../lib/dataFormat.js";
import { getErrorMessage, padVersion, versionToNumber } from "../lib/shared.js";
import { NodeFS } from "./nodeFS.js";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = path.resolve(__dirname, "../../firmwares");
const outDir = join(__dirname, "../../dist/data");

void (async () => {
	const configFiles = (await NodeFS.readDir(configDir, true))
		.filter(
			(file) =>
				file.endsWith(".json") &&
				!file.endsWith("index.json") &&
				!path.basename(file).startsWith("_") &&
				!file.includes("/templates/") &&
				!file.includes("\\templates\\"),
		)
		// Sort for a deterministic version hash and shard layout
		.sort();

	const files: { filename: string; data: string }[] = [];
	for (const filePath of configFiles) {
		const relativePath = path
			.relative(configDir, filePath)
			.replace(/\\/g, "/");
		const fileContent = await NodeFS.readFile(filePath);
		files.push({ filename: relativePath, data: fileContent });
	}

	const hasher = crypto.createHash("sha256");
	const version = hasher
		.update(JSON.stringify(files), "utf8")
		.digest("hex")
		.slice(0, 8);

	const shards = new Map<string, DataShard>();
	for (const file of files) {
		let config: ConditionalUpdateConfig;
		try {
			config = new ConditionalUpdateConfig(JSON5.parse(file.data));
		} catch (e) {
			console.error(
				`Error parsing config file ${file.filename}: ${getErrorMessage(e)}`,
			);
			process.exit(1);
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

	await fs.rm(outDir, { recursive: true, force: true });
	await fs.mkdir(join(outDir, "shards"), { recursive: true });

	for (const [manufacturerId, shard] of shards) {
		await fs.writeFile(
			join(outDir, getShardPath(manufacturerId)),
			JSON.stringify(shard),
			"utf8",
		);
	}

	const manifest: DataManifest = {
		version,
		shards: [...shards.keys()].sort(),
	};
	await fs.writeFile(
		join(outDir, MANIFEST_PATH),
		JSON.stringify(manifest),
		"utf8",
	);

	console.log(
		`Built data version ${version}: ${files.length} config files, ${shards.size} shards`,
	);
})();
