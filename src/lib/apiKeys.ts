import { array2hex, hex2array } from "./shared";

const IV_LEN = 12;
const AUTH_TAG_LEN = 8;

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

export function encodeAPIKey(apiKey: APIKey): ArrayBuffer {
	const ret = new ArrayBuffer(16);
	const view = new DataView(ret);
	view.setUint32(0, apiKey.id);
	view.setUint16(4, apiKey.rateLimit >>> 8);
	view.setUint8(6, apiKey.rateLimit & 0xff);
	return ret;
}

export function decodeAPIKey(apiKey: ArrayBuffer): APIKey {
	if (apiKey.byteLength !== 16) {
		throw new Error("apiKey must have a length of 16 bytes");
	}

	const view = new DataView(apiKey);
	const id = view.getUint32(0);
	const rateLimit = (view.getUint16(4) << 8) | view.getUint8(6);

	if (rateLimit <= 0) {
		throw new Error("rateLimit must be greater than 0");
	}

	for (let i = 7; i < view.byteLength; i++) {
		if (view.getUint8(i) !== 0) {
			throw new Error("Unsupported API key format");
		}
	}

	return {
		id,
		rateLimit,
	};
}

export async function decryptAPIKey(
	key: ArrayBuffer,
	apiKeyHex: string
): Promise<APIKey> {
	// Decrypt API key using AES-256-GCM to check if it is valid.
	// The API key is encoded as hex with the IV prepended and auth tag appended.
	if (
		apiKeyHex.length !== (IV_LEN + 16 + AUTH_TAG_LEN) * 2 ||
		!/^[0-9a-f]+$/.test(apiKeyHex)
	) {
		throw new Error("Invalid API key");
	}

	const apiKeyBytes = hex2array(apiKeyHex);

	const iv = apiKeyBytes.subarray(0, IV_LEN);
	const ciphertext = apiKeyBytes.subarray(IV_LEN);

	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		"AES-GCM",
		false,
		["decrypt"]
	);

	let apiKeyDecoded;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv,
				tagLength: AUTH_TAG_LEN * 8,
			},
			cryptoKey,
			ciphertext
		);
		apiKeyDecoded = decodeAPIKey(plaintext);
	} catch (err) {
		throw new Error("Invalid API key");
	}

	return apiKeyDecoded;
}

export async function encryptAPIKey(
	key: ArrayBuffer,
	apiKey: APIKey
): Promise<string> {
	const iv = new Uint8Array(IV_LEN);
	crypto.getRandomValues(iv);

	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		"AES-GCM",
		false,
		["encrypt"]
	);

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				tagLength: AUTH_TAG_LEN * 8,
			},
			cryptoKey,
			encodeAPIKey(apiKey)
		)
	);

	const ret = new Uint8Array(iv.length + ciphertext.length);
	ret.set(iv);
	ret.set(ciphertext, iv.length);

	return array2hex(ret);
}
