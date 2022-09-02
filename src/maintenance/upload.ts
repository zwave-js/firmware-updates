import axios from "axios";
import JSON5 from "json5";
import crypto from "node:crypto";
import path from "path-browserify";
import type { ConfigIndexEntry } from "../lib/config";
import type { UploadPayload } from "../lib/uploadSchema";
import { NodeFS } from "./nodeFS";

const configDir = path.join(__dirname, "../../firmwares");
const MAX_FILES_PER_REQUEST = 500;
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

	const files: { filename: string; data: string }[] = [];
	for (const entry of index) {
		const filenameFull = path.join(configDir, entry.filename);
		const fileContent = await NodeFS.readFile(filenameFull);
		files.push({ filename: entry.filename, data: fileContent });
	}

	const version = crypto.randomBytes(4).toString("hex");
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
			new URL("/admin/updateConfig", baseURL).toString(),
			payload,
			{
				headers: { "x-admin-secret": adminSecret },
			}
		);

		cursor += MAX_FILES_PER_REQUEST;
	}

	const finalizePayload: UploadPayload = {
		version,
		actions: [
			{ task: "put", filename: "index.json", data: indexContent },
			{ task: "enable" },
		],
	};
	console.log("finalizing...");
	await axios.post(
		new URL("/admin/updateConfig", baseURL).toString(),
		finalizePayload,
		{
			headers: { "x-admin-secret": adminSecret },
		}
	);
	console.log("done!");
})();
