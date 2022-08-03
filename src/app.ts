import fastify, { FastifyInstance, FastifyServerOptions } from "fastify";

export async function build(
	opts: FastifyServerOptions = {},
): Promise<FastifyInstance> {
	const app = fastify(opts);

	await app.register(import("@fastify/helmet"));

	app.get("/", async (_request, reply) => {
		return reply.type("text/html").send(`
			<h1>Z-Wave JS Firmware Update Service</h1>
			<p>
				See documentation on <a href="https://github.com/zwave-js/firmware-updates">GitHub</a>.
			</p>
		`);
	});

	await app.register(import("./routes/api"));

	return app;
}
