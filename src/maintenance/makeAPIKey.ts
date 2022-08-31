// Call this with:
// ts-node src/maintenance/makeAPIKey.ts <id> <req-per-hour>

// Creates an API key with the given information. In order to work, the
// API_KEY_ENC_KEY environment variable must be set to the same value as on production

import "dotenv/config";

import { encryptAPIKey } from "../lib/apiKeys";

const id = parseInt(process.argv[2]);
const limit = parseInt(process.argv[3]);
if (Number.isNaN(id) || id < 1 || Number.isNaN(limit) || limit < 1) {
	console.error("Usage: node makeAPIKey.js <id> <req-per-hour>");
	process.exit(1);
}

const keyHex = process.env.API_KEY_ENC_KEY;
if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
	console.error("API_KEY_ENC_KEY env var not provided");
	process.exit(1);
}
const key = Buffer.from(keyHex, "hex");

const apiKey = encryptAPIKey(key, { id, rateLimit: limit });
console.log(apiKey);
