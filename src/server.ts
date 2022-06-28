import fastify, { FastifyInstance } from "fastify";

const server: FastifyInstance = fastify({ logger: true });

// Declare a route
server.get("/", async (_request, _reply) => {
	return { hello: "world!" };
});

// Run the server!
async function start() {
	let port = parseInt(process.env.PORT!);
	if (isNaN(port)) port = 3000;

	try {
		await server.listen({
			host: "::",
			port,
		});
	} catch (err) {
		server.log.error(err);
		process.exit(1);
	}
}
void start();
