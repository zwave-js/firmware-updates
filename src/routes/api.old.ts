import type { FastifyPluginCallback } from "fastify";
import { APIv1_RequestSchema } from "../apiV1.js";
import { getAPIKey } from "../lib/apiKeys";
import { lookupConfig } from "../lib/config";

const api: FastifyPluginCallback = async (app, opts, done) => {
	if (process.env.API_REQUIRE_KEY !== "false") {
		await app.register(import("../plugins/checkAPIKey"));
	}

	await app.register(import("@fastify/rate-limit"), {
		global: true,
		keyGenerator:
			process.env.API_REQUIRE_KEY !== "false"
				? (req) => getAPIKey(req)?.id.toString() ?? "anonymous"
				: undefined,
		max: (req) => getAPIKey(req)?.rateLimit ?? 1000,
		timeWindow: "1 hour",
	});

	app.post("/api/v1/updates", async (request, reply) => {
		const result = await APIv1_RequestSchema.safeParseAsync(request.body);
		if (!result.success) {
			// Invalid request
			return reply.code(400).send(result.error.format());
		}
		const { manufacturerId, productType, productId, firmwareVersion } =
			result.data;

		const config = await lookupConfig(
			manufacturerId,
			productType,
			productId,
			firmwareVersion,
		);
		if (!config) {
			// Config not found
			return reply.send([]);
		}

		return config.upgrades;
	});

	done();
};

export default api;
