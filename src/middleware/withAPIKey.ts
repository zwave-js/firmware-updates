import { BetterKV } from "flareutils";
import { error } from "itty-router-extras";
import { APIKey, decryptAPIKey } from "../lib/apiKeys";
import { hex2array } from "../lib/shared";
import type { CloudflareEnvironment } from "../worker";

export async function withAPIKey(
	req: Request,
	env: CloudflareEnvironment,
	context: ExecutionContext
): Promise<Response | undefined> {
	const fail = (message: string, code: number) => {
		if (env.API_REQUIRE_KEY !== "false") {
			return error(code, { error: message });
		}
	};

	const apiKeyHex = req.headers.get("x-api-key");
	if (typeof apiKeyHex !== "string" || !apiKeyHex) {
		return fail("API key not provided", 401);
	}

	// If the API key is stored in KV, use that
	const API_KEYS = new BetterKV(
		env.API_KEYS,
		context.waitUntil.bind(context),
		"API_KEYS_v1"
	);
	let apiKey = await API_KEYS.get<APIKey>(apiKeyHex, {
		type: "json",
		// Cache read API keys for 30 minutes - this should be quick enough if a
		// key ever changes, and still cut down on KV reads by a lot
		cacheTtl: 30 * 60,
	});

	// otherwise, decrypt it
	if (!apiKey) {
		const keyHex = env.API_KEY_ENC_KEY;
		if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
			return fail("Setup not complete", 500);
		}
		const key = hex2array(keyHex); // Buffer.from(keyHex, "hex");

		try {
			apiKey = await decryptAPIKey(key, apiKeyHex);
		} catch (e: any) {
			return fail(e.message, 401);
		}
	}

	(req as any).apiKey = apiKey;
}

export type APIKeyProps = { apiKey?: APIKey };
