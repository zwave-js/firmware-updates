import { error } from "itty-router-extras";
import { APIKey, decryptAPIKey } from "../lib/apiKeys";
import { hex2array } from "../lib/shared";
import type { CloudflareEnvironment } from "../worker";

export async function withAPIKey(
	req: Request,
	env: CloudflareEnvironment
): Promise<Response | undefined> {
	const fail = (message: string, code: number) => {
		if (env.API_REQUIRE_KEY !== "false") {
			return error(code, { error: message });
		}
	};

	const keyHex = env.API_KEY_ENC_KEY;
	if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
		return fail("Setup not complete", 500);
	}
	const key = hex2array(keyHex); // Buffer.from(keyHex, "hex");

	const apiKeyHex = req.headers.get("x-api-key");
	if (typeof apiKeyHex !== "string" || !apiKeyHex) {
		return fail("API key not provided", 401);
	}

	let apiKey: APIKey;
	try {
		apiKey = await decryptAPIKey(key, apiKeyHex);
	} catch (e: any) {
		return fail(e.message, 401);
	}

	(req as any).apiKey = apiKey;
}

export type APIKeyProps = { apiKey?: APIKey };
