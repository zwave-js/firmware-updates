import fastifyLib from "fastify";

const fastify = fastifyLib({ logger: true });

// Declare a route
fastify.get("/", async (_request, _reply) => {
	return { hello: "world!" };
});

// Run the server!
async function start() {
	try {
		await fastify.listen({ port: 3000 });
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
}
void start();
