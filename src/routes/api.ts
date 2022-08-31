import { APIv1_RequestSchema } from "../apiV1";
import type { Router } from "../lib/router";

export default function register(router: Router): void {
	// TODO: Re-enable API KEY
	// if (process.env.API_REQUIRE_KEY !== "false") {
	// 	await app.register(import("../plugins/checkAPIKey"));
	// }

	// TODO: Re-enable rate limiter
	// await app.register(import("@fastify/rate-limit"), {
	// 	global: true,
	// 	keyGenerator:
	// 		process.env.API_REQUIRE_KEY !== "false"
	// 			? (req) => getAPIKey(req)?.id.toString() ?? "anonymous"
	// 			: undefined,
	// 	max: (req) => getAPIKey(req)?.rateLimit ?? 1000,
	// 	timeWindow: "1 hour",
	// });

	router.post("/api/v1/updates", async ({ req, res }) => {
		const result = await APIv1_RequestSchema.safeParseAsync(req.body);
		if (!result.success) {
			// Invalid request
			res.status = 400;
			res.body = result.error.format();
			console.log(res.body);
			return;
		}
		const { manufacturerId, productType, productId, firmwareVersion } =
			result.data;

		// const config = await lookupConfig(
		// 	// TODO: Make this dynamic
		// 	"/home/dominic/Repositories/firmware-updates/firmwares",
		// 	manufacturerId,
		// 	productType,
		// 	productId,
		// 	firmwareVersion,
		// );
		const config = undefined as any;
		if (!config) {
			// Config not found
			res.body = [];
			return;
		}

		res.body = config.upgrades;
	});
}
