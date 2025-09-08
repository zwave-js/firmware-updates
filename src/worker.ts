import { build } from "./app";

export interface CloudflareEnvironment {
	API_REQUIRE_KEY: string;
	API_KEY_ENC_KEY: string;
	ADMIN_SECRET?: string;

	DB: D1Database;

	API_KEYS: KVNamespace;
	RL_FREE: RateLimit;

	responseHeaders: Record<string, string>;
}

const router = build();

export default {
	async fetch(
		request: Request,
		env: CloudflareEnvironment,
		context: ExecutionContext
	): Promise<Response> {
		env = { ...env, responseHeaders: {} };
		const resp: Response = await router.handle(request, env, context);
		for (const [key, value] of Object.entries(env.responseHeaders)) {
			resp.headers.set(key, value);
		}
		return resp;
	},
};
