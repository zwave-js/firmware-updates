import fastify, { FastifyInstance, FastifyServerOptions } from "fastify";

export function build(opts: FastifyServerOptions = {}): FastifyInstance {
	const app = fastify(opts);

	app.get("/", async (_request, _reply) => {
		return { hello: "world!" };
	});

	return app;
}
