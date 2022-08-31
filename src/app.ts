import {Router} from "./lib/router";
import registerAPI from "./routes/api";

export function build(): Router {
	// opts: FastifyServerOptions = {},
	// Initialize router
	const router = new Router();

	// Enabling builtin CORS support
	router.cors();

	// Parse JSON, even when the content-type is not set
	router.use(async ({ req, res, next }) => {
		if (
			["POST", "PUT", "PATCH"].includes(req.method) &&
			typeof req.body === "string"
		) {
			try {
				req.body = JSON.parse(req.body);
			} catch {
				res.status = 400;
				return;
			}
		}
		await next();
	});

	router.get("/", ({ req: _, res }) => {
		res.headers.set("content-type", "text/html");
		res.body = `
			<h1>Z-Wave JS Firmware Update Service</h1>
			<p>
				See documentation on <a href="https://github.com/zwave-js/firmware-updates">GitHub</a>.
			</p>
		`;
	});

	registerAPI(router);

	return router;

	// const app = fastify(opts);

	// await app.register(import("@fastify/helmet"));

	// return app;
}
