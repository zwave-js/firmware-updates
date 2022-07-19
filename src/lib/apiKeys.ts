import type { FastifyRequest } from "fastify";
import assert from "node:assert";
import crypto from "node:crypto";

export interface APIKey {
	id: number;
	/** The maximum number of requests per hour */
	rateLimit: number;
}

// Encoded API key format:
// aaaabbb000000000
// aaaa = id (big-endian)
// bbbb = requests per hour (big-endian)
// 0000 = reserved for future use

export function encodeAPIKey(apiKey: APIKey): Buffer {
	const ret = Buffer.alloc(16, 0);
	ret.writeUInt32BE(apiKey.id, 0);
	ret.writeUIntBE(apiKey.rateLimit, 4, 3);
	return ret;
}

export function decodeAPIKey(apiKey: Buffer): APIKey {
	assert(apiKey.length === 16);

	const id = apiKey.readUInt32BE(0);
	const rateLimit = apiKey.readUIntBE(4, 3);

	assert(rateLimit > 0);

	assert(apiKey.subarray(7).every((v) => v === 0));

	return {
		id,
		rateLimit,
	};
}

export function decryptAPIKey(key: Buffer, apiKeyHex: string): APIKey {
	// Decrypt API key using AES-256-CBC to check if it is valid.
	// The API key is encoded as hex with the IV prepended.
	if (!/^[0-9a-f]{96}$/.test(apiKeyHex)) {
		throw new Error("Invalid API key");
	}

	const apiKeyBytes = Buffer.from(apiKeyHex, "hex");

	const iv = apiKeyBytes.subarray(0, 16);
	const ciphertext = apiKeyBytes.subarray(16);
	const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

	let apiKeyDecoded: APIKey;
	try {
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		apiKeyDecoded = decodeAPIKey(plaintext);
	} catch (err) {
		throw new Error("Invalid API key");
	}

	return apiKeyDecoded;
}

export function encryptAPIKey(key: Buffer, apiKey: APIKey): string {
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

	const ciphertext = Buffer.concat([
		iv,
		cipher.update(encodeAPIKey(apiKey)),
		cipher.final(),
	]);
	return ciphertext.toString("hex");
}

export function getAPIKey(req: FastifyRequest): APIKey | undefined {
	return (req as any).apiKey;
}
