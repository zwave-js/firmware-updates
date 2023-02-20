import { error } from "itty-router-extras";
import { APIKey, decryptAPIKey } from "../lib/apiKeys";
import { withCache } from "../lib/cache";
import { hex2array } from "../lib/shared";
import type { CloudflareEnvironment } from "../worker";

const CACHE_KEY_PREFIX = "/__kv-cache/";

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
	const cacheKey = new URL(CACHE_KEY_PREFIX + apiKeyHex, req.url).toString();
	const apiKeyResponse = await withCache(
		{
			context,
			cacheKey,
			// Cache read API keys for 30 minutes - this should be quick enough if a
			// key ever changes, and still cut down on KV reads by a lot
			sMaxAge: 30 * 60,
		},
		async () => {
			return new Response(await env.API_KEYS.get(apiKeyHex));
		}
	);
	const apiKeyText = apiKeyResponse.body && (await apiKeyResponse.text());
	let apiKey = apiKeyText && (JSON.parse(apiKeyText) as APIKey);

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
