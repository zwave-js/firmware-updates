import axios from "axios";
import JSON5 from "json5";
import crypto from "node:crypto";
import path from "path-browserify";
import type { ConfigIndexEntry } from "../lib/config";
import type { UploadPayload } from "../lib/uploadSchema";
import { NodeFS } from "./nodeFS";

import { dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = path.resolve(__dirname, "../../firmwares");
const MAX_FILES_PER_REQUEST = 50; // limited by no. of subrequests in Cloudflare Workers
const baseURL = process.env.BASE_URL;
const adminSecret = process.env.ADMIN_SECRET;

if (!baseURL) {
	console.error();
	console.error("ERROR: Missing BASE_URL environment variable");
	process.exit(1);
} else if (!adminSecret) {
	console.error();
	console.error("ERROR: Missing ADMIN_SECRET environment variable");
	process.exit(1);
}

void (async () => {
	const indexContent = await NodeFS.readFile(
		path.join(configDir, "index.json")
	);
	const index = JSON5.parse<ConfigIndexEntry[]>(indexContent);

	const files: { filename: string; data: string }[] = [
		{ filename: "index.json", data: indexContent },
	];
	for (const entry of index) {
		const filenameFull = path.join(configDir, entry.filename);
		const fileContent = await NodeFS.readFile(filenameFull);
		files.push({ filename: entry.filename, data: fileContent });
	}

	const hasher = crypto.createHash("sha256");
	const data = JSON.stringify(files);
	const version = hasher.update(data, "utf8").digest("hex").slice(0, 8);

	const { data: onlineVersion } = await axios.get<string>(
		new URL("/admin/config/version", baseURL).toString(),
		{
			headers: { "x-admin-secret": adminSecret },
		}
	);

	if (onlineVersion === version) {
		console.log("No change in config files, skipping upload...");
		return;
	}

	let cursor = 0;

	while (cursor < files.length) {
		const currentBatch = files.slice(
			cursor,
			cursor + MAX_FILES_PER_REQUEST
		);

		const payload: UploadPayload = {
			version,
			actions: currentBatch.map((f) => ({
				task: "put",
				...f,
			})),
		};
		console.log(
			`Uplaoding files ${cursor + 1}...${
				cursor + currentBatch.length
			} of ${files.length}...`
		);
		await axios.post(
			new URL("/admin/config/upload", baseURL).toString(),
			payload,
			{
				headers: { "x-admin-secret": adminSecret },
			}
		);

		cursor += MAX_FILES_PER_REQUEST;
	}

	const finalizePayload: UploadPayload = {
		version,
		actions: [{ task: "enable" }],
	};
	console.log("finalizing...");
	await axios.post(
		new URL("/admin/config/upload", baseURL).toString(),
		finalizePayload,
		{
			headers: { "x-admin-secret": adminSecret },
		}
	);
	console.log("done!");
})();
