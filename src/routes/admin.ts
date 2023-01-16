import { withDurables } from "itty-durable";
import {
	json,
	missing,
	text,
	withParams,
	type ThrowableRouter,
} from "itty-router-extras";
import type { RateLimiterProps } from "../durable_objects/RateLimiter";
import { encryptAPIKey } from "../lib/apiKeys";
import {
	createCachedR2FS,
	getFilesVersion,
	putFilesVersion,
} from "../lib/fs/cachedR2FS";
import { hex2array } from "../lib/shared";
import {
	clientError,
	ContentProps,
	safeCompare,
	type RequestWithProps,
} from "../lib/shared_cloudflare";
import { uploadSchema } from "../lib/uploadSchema";
import type { CloudflareEnvironment } from "../worker";

export default function register(router: ThrowableRouter): void {
	// Verify the admin token
	router.post("/admin/*", (req: Request, env: CloudflareEnvironment) => {
		// Avoid timing attacks, but still do not do unnecessary work
		const secret = req.headers.get("x-admin-secret");
		if (
			!secret ||
			!env.ADMIN_SECRET ||
			!safeCompare(env.ADMIN_SECRET, secret)
		) {
			return missing();
		}
	});

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
			const id = parseInt(req.params.id);
			const limit = parseInt(req.params.limit);
			if (
				Number.isNaN(id) ||
				id < 1 ||
				Number.isNaN(limit) ||
				limit < 1
			) {
				console.error("Usage: /admin/makeKey/:id/:limit");
				return clientError("Invalid id or limit");
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
		"/admin/config/upload",
		async (
			req: RequestWithProps<[ContentProps]>,
			env: CloudflareEnvironment,
			context: ExecutionContext
		) => {
			try {
				const result = await uploadSchema.safeParseAsync(req.content);
				if (!result.success) {
					return clientError(result.error.format() as any);
				}

				const newVersion = result.data.version;
				const fs = createCachedR2FS(
					req.url,
					context,
					env.CONFIG_FILES,
					newVersion
				);

				for (const action of result.data.actions) {
					if (action.task === "put") {
						// Upload a file for the current revision/version
						if (!action.filename.startsWith("/")) {
							action.filename = "/" + action.filename;
						}

						await fs.writeFile(action.filename, action.data);
					} else if (action.task === "enable") {
						// Enable the current revision, delete all other revisions
						const oldVersion = await getFilesVersion(
							req.url,
							context,
							env.CONFIG_FILES
						);
						if (oldVersion && oldVersion !== newVersion) {
							const oldFs = createCachedR2FS(
								req.url,
								context,
								env.CONFIG_FILES,
								oldVersion
							);
							await oldFs.deleteDir("/");
						}

						// Update version file, so new requests will use the new version
						await putFilesVersion(
							req.url,
							context,
							env.CONFIG_FILES,
							newVersion
						);

						// Make sure not to write any extra files after this
						break;
					}
				}
			} catch (e: any) {
				console.error(e.stack);
				throw e;
			}

			return json({ ok: true });
		}
	);

	router.get(
		"/admin/config/version",
		async (
			req: Request,
			env: CloudflareEnvironment,
			context: ExecutionContext
		) => {
			const ret = await getFilesVersion(
				req.url,
				context,
				env.CONFIG_FILES
			);
			return text(ret || "");
		}
	);

	router.post(
		"/admin/resetRateLimit/:id/:limit",
		withParams,
		withDurables({ parse: true }),
		async (
			req: RequestWithProps<
				[{ params: { id: string; limit: string } }, RateLimiterProps]
			>,
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
				console.error("Usage: /admin/resetRateLimit/:id/:limit");
				return clientError("Invalid id or limit");
			}

			const objId = env.RateLimiter.idFromName(req.params.id);
			const RateLimiter = req.RateLimiter.get(objId);
			await RateLimiter.setTo(limit);

			return json({ ok: true });
		}
	);
}
