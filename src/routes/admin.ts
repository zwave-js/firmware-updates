import { json, withParams, type ThrowableRouter } from "itty-router-extras";
import { encryptAPIKey } from "../lib/apiKeys";
import {
	hex2array,
	safeCompare,
	type RequestWithProps,
} from "../lib/shared_safe";
import type { CloudflareEnvironment } from "../worker";

export default function register(router: ThrowableRouter): void {
	// Creates an API key with the given information. In order to work, the
	// API_KEY_ENC_KEY environment variable must be set to the same value as on production
	// and the ADMIN_SECRET environment variable must be configured.
	//
	// Call this using a HTTP request
	//
	// POST http://127.0.0.1:8787/admin/makeKey/:id/:requests-per-hour
	// x-admin-secret: <your-admin-secret>

	router.post(
		"/admin/makeKey/:id/:limit",
		withParams,
		async (
			req: RequestWithProps<[{ params: { id: string; limit: string } }]>,
			env: CloudflareEnvironment
		) => {
			// Avoid timing attacks, but still do not do unnecessary work
			const secret = req.headers.get("x-admin-secret");
			if (
				!secret ||
				!env.ADMIN_SECRET ||
				!safeCompare(env.ADMIN_SECRET, secret)
			) {
				return json({ ok: true });
			}

			const id = parseInt(req.params.id);
			const limit = parseInt(req.params.limit);
			if (
				Number.isNaN(id) ||
				id < 1 ||
				Number.isNaN(limit) ||
				limit < 1
			) {
				console.error("Usage: /admin/makeKey/:id/:limit");
				process.exit(1);
			}

			const key = hex2array(env.API_KEY_ENC_KEY);
			const apiKey = await encryptAPIKey(key, {
				id,
				rateLimit: limit,
			});
			// ONLY log on the console
			console.log(" ");
			console.log(`key for ID`, id, "limit:", limit);
			console.log(apiKey);
			console.log(" ");

			return json({ ok: true });
		}
	);
}
