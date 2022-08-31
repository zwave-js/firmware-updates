import { build } from "./app";

export interface CloudflareEnvironment {
	// 	APP_ID: string;
	// 	WEBHOOK_SECRET: string;
	// 	PRIVATE_KEY: string;
	FOO: any;
}

const router = build();

export default {
	async fetch(
		request: Request,
		env: CloudflareEnvironment,
		_context: ExecutionContext,
	): Promise<Response> {
		return router.handle(env, request);
	},
};
