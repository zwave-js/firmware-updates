import {
	json,
	missing,
	withParams,
	type ThrowableRouter,
} from "itty-router-extras";
import { encryptAPIKey } from "../lib/apiKeys";
import { createR2FS } from "../lib/fs/r2";
import {
	clientError,
	ContentProps,
	hex2array,
	safeCompare,
	type RequestWithProps,
} from "../lib/shared";
import { uploadSchema } from "../lib/uploadSchema";
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

	// Verify the admin token
	router.post(
		"/admin/*",
		async (req: Request, env: CloudflareEnvironment) => {
			// Avoid timing attacks, but still do not do unnecessary work
			const secret = req.headers.get("x-admin-secret");
			if (
				!secret ||
				!env.ADMIN_SECRET ||
				!safeCompare(env.ADMIN_SECRET, secret)
			) {
				return missing();
			}
		}
	);

	router.post(
		"/admin/makeKey/:id/:limit",
		withParams,
		async (
			req: RequestWithProps<[{ params: { id: string; limit: string } }]>,
			env: CloudflareEnvironment
		) => {
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

	router.post(
		"/admin/updateConfig",
		async (
			req: RequestWithProps<[ContentProps]>,
			env: CloudflareEnvironment
		) => {
			const result = await uploadSchema.safeParseAsync(req.content);
			if (!result.success) {
				return clientError(result.error.format() as any);
			}

			const fs = createR2FS(env.CONFIG_FILES);

			for (const action of result.data) {
				if (action.task === "clear") {
					await fs.deleteDir("/");
				} else if (action.task === "put") {
					if (!action.filename.startsWith("/")) {
						action.filename = "/" + action.filename;
					}

					await fs.writeFile(
						action.filename,
						JSON.stringify(action.data)
					);
				}
			}

			return json({ ok: true });
		}
	);
}
