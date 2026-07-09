import fs from "node:fs/promises";
import path from "path-browserify";
import { getShardPath, MANIFEST_PATH } from "../lib/dataFormat.js";
import {
	buildDataShards,
	buildManifest,
	hashConfigFiles,
	readConfigFiles,
} from "./dataBuild.js";
import { NodeFS } from "./nodeFS.js";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = path.resolve(__dirname, "../../firmwares");
const outDir = join(__dirname, "../../dist/data");

// Fail the build (and thereby the deploy) if the dataset shrinks implausibly,
// e.g. because a failed directory read silently yielded an empty file list
const MIN_CONFIG_FILES = 100;
const MIN_SHARDS = 10;

void (async () => {
	const files = await readConfigFiles(NodeFS, configDir);
	const version = hashConfigFiles(files);

	let shards;
	try {
		shards = buildDataShards(files);
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}

	if (files.length < MIN_CONFIG_FILES || shards.size < MIN_SHARDS) {
		console.error(
			`ERROR: Implausibly small dataset (${files.length} config files, ${shards.size} shards), refusing to build`,
		);
		process.exit(1);
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

	await fs.writeFile(
		join(outDir, MANIFEST_PATH),
		JSON.stringify(buildManifest(version, shards)),
		"utf8",
	);

	console.log(
		`Built data version ${version}: ${files.length} config files, ${shards.size} shards`,
	);
})();
