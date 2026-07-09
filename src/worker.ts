import { build } from "./app.js";

export interface CloudflareEnvironment {
	/** Static assets containing the prebuilt firmware update data */
	DATA: Fetcher;

	RL_GLOBAL: RateLimit;
	RL_BURST: RateLimit;

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
		const resp: Response = await router.fetch(request, env, context);
		for (const [key, value] of Object.entries(env.responseHeaders)) {
			resp.headers.set(key, value);
		}
		return resp;
	},
};
