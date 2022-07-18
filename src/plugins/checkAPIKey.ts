import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";
import { APIKey, decryptAPIKey } from "../lib/apiKeys";

const checkAPIKeyPlugin: FastifyPluginCallback = (instance, opts, done) => {
	instance.addHook("onRequest", async (request, reply) => {
		const keyHex = process.env.API_KEY_ENC_KEY;
		if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
			throw new Error("Setup not complete");
		}
		const key = Buffer.from(keyHex, "hex");

		const apiKeyHex = request.headers["x-api-key"];
		if (typeof apiKeyHex !== "string" || !apiKeyHex) {
			return reply.code(401).send({ error: "API key not provided" });
		}

		let apiKey: APIKey;
		try {
			apiKey = decryptAPIKey(key, apiKeyHex);
		} catch (e: any) {
			return reply.code(401).send({ error: e.message });
		}

		(request as any).apiKey = apiKey;
	});

	done();
};

export default fp(checkAPIKeyPlugin);
