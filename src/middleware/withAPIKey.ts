import { APIKey, decryptAPIKey } from "../lib/apiKeys";
import { clientError, hex2array } from "../lib/shared";
import type { CloudflareEnvironment } from "../worker";

export async function withAPIKey(
	req: Request,
	env: CloudflareEnvironment
): Promise<Response | undefined> {
	if (env.API_REQUIRE_KEY !== "false") {
		const keyHex = env.API_KEY_ENC_KEY;
		if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
			throw new Error("Setup not complete");
		}
		const key = hex2array(keyHex); // Buffer.from(keyHex, "hex");

		const apiKeyHex = req.headers.get("x-api-key");
		if (typeof apiKeyHex !== "string" || !apiKeyHex) {
			return clientError({ error: "API key not provided" }, 401);
		}

		let apiKey: APIKey;
		try {
			apiKey = await decryptAPIKey(key, apiKeyHex);
		} catch (e: any) {
			return clientError({ error: e.message }, 401);
		}

		(req as any).apiKey = apiKey;
	}
}

export type APIKeyProps = { apiKey?: APIKey };
