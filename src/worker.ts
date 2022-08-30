import type { HTTPMethods } from "fastify";
import { build } from "./app";

export interface CloudflareEnvironment {
	// 	APP_ID: string;
	// 	WEBHOOK_SECRET: string;
	// 	PRIVATE_KEY: string;
	FOO: any;
}

export default {
	async fetch(
		request: Request,
		_env: CloudflareEnvironment,
		_context: ExecutionContext,
	): Promise<Response> {
		const server = await build({
			logger: {
				level: "info",
			},
		});

		const { method, url, headers, body: payload } = request;

		const response = await server.inject({
			method: method as HTTPMethods,
			url,
			headers: Object.fromEntries(headers),
			payload: payload ?? undefined,
		});

		return new Response(response.body, {
			status: response.statusCode,
			statusText: response.statusMessage,
			headers: response.headers as any,
		});
	},
};
