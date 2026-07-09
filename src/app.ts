import { error, Router, withContent } from "itty-router";
import registerAPI from "./routes/api.js";

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function build() {
	// Initialize router
	const router = Router();

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

	router.all("*", () => error(404));

	return router;
}
