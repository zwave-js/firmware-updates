import { ThrowableRouter, withContent } from "itty-router-extras";
import registerAdmin from "./routes/admin";
import registerAPI from "./routes/api";

export function build(): ThrowableRouter {
	// opts: FastifyServerOptions = {},
	// Initialize router
	const router = ThrowableRouter();

	router.get("/", (_request) => {
		return new Response(
			`
<h1>Z-Wave JS Firmware Update Service</h1>
<p>
	See documentation on <a href="https://github.com/zwave-js/firmware-updates">GitHub</a>.
</p>`,
			{
				headers: {
					"Content-Type": "text/html",
				},
			}
		);
	});

	// Parse JSON for POST requests
	router.post("*", withContent);

	registerAPI(router);
	registerAdmin(router);

	return router;

	// const app = fastify(opts);

	// await app.register(import("@fastify/helmet"));

	// return app;
}
