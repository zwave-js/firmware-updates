import fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import { APIv1_RequestSchema } from "./apiV1";
import { lookupConfig } from "./lib/config";

export function build(opts: FastifyServerOptions = {}): FastifyInstance {
	const app = fastify(opts);

	app.get("/", async (_request, reply) => {
		return reply.type("text/html").send(`
			<h1>Z-Wave JS Firmware Update Service</h1>
			<p>
				See documentation on <a href="https://github.com/zwave-js/firmware-updates">GitHub</a>.
			</p>
		`);
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

	return app;
}
