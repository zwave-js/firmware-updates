import axios from "axios";
import crypto from "node:crypto";
import path from "path-browserify";
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
	// Find all config files directly instead of using index.json
	const configFiles = (await NodeFS.readDir(configDir, true)).filter(
		(file) =>
			file.endsWith(".json") &&
			!file.endsWith("index.json") &&
			!path.basename(file).startsWith("_") &&
			!file.includes("/templates/") &&
			!file.includes("\\templates\\")
	);

	const files: { filename: string; data: string }[] = [];

	for (const filePath of configFiles) {
		const relativePath = path
			.relative(configDir, filePath)
			.replace(/\\/g, "/");
		const fileContent = await NodeFS.readFile(filePath);
		files.push({ filename: relativePath, data: fileContent });
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

	// First, create the new config version
	console.log("Creating config version...");
	const createPayload: UploadPayload = {
		version,
		actions: [{ task: "create" }],
	};
	await axios.post(
		new URL("/admin/config/upload", baseURL).toString(),
		createPayload,
		{
			headers: { "x-admin-secret": adminSecret },
		}
	);

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
			`Uploading files ${cursor + 1}...${
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
