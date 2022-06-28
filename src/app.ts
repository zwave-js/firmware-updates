import fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import { z } from "zod";
import { lookupConfig } from "./lib/config";
import { firmwareVersionSchema } from "./lib/configSchema";
import { hexKeyRegex4Digits } from "./lib/shared";

const requestSchema = z.object({
	manufacturerId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productType: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	firmwareVersion: firmwareVersionSchema,
});

export function build(opts: FastifyServerOptions = {}): FastifyInstance {
	const app = fastify(opts);

	app.get("/", async (_request, _reply) => {
		return { hello: "world!" };
	});

	app.post("/api/v1/updates", async (request, reply) => {
		const result = await requestSchema.safeParseAsync(request.body);
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

	return app;
}
