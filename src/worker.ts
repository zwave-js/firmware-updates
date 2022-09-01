import { build } from "./app";

export interface CloudflareEnvironment {
	// 	APP_ID: string;
	// 	WEBHOOK_SECRET: string;
	// 	PRIVATE_KEY: string;
	API_REQUIRE_KEY: string;
	API_KEY_ENC_KEY: string;
	ADMIN_SECRET?: string;
	responseHeaders: Record<string, string>;
}

const router = build();

export { RateLimiter as RateLimiterDurableObject } from "./durable_objects/RateLimiter";

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
