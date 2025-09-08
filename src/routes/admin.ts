import {
	json,
	missing,
	text,
	withParams,
	type ThrowableRouter,
} from "itty-router-extras";
import { encryptAPIKey } from "../lib/apiKeys";
import {
	createCachedR2FS,
	getFilesVersion,
	putFilesVersion,
} from "../lib/fs/cachedR2FS";
import { getCurrentVersion, setActiveVersion, insertConfigData, deleteConfigVersion } from "../lib/d1Operations";
import { ConditionalUpdateConfig } from "../lib/config";
import { hex2array } from "../lib/shared";
import {
	clientError,
	ContentProps,
	safeCompare,
	type RequestWithProps,
} from "../lib/shared_cloudflare";
import { uploadSchema } from "../lib/uploadSchema";
import type { CloudflareEnvironment } from "../worker";
import JSON5 from "json5";

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
				const configData: { devices: any[], upgrades: any[] }[] = [];

				for (const action of result.data.actions) {
					if (action.task === "put") {
						// Process config file data for D1 insertion
						if (action.filename === "index.json") {
							// Skip index.json as we don't need it anymore
							continue;
						}

						try {
							const definition = JSON5.parse(action.data);
							const config = new ConditionalUpdateConfig(definition);
							configData.push({
								devices: config.devices,
								upgrades: config.upgrades
							});
						} catch (e) {
							console.error(`Error parsing config file ${action.filename}:`, e);
							// Skip invalid files but don't fail the whole upload
							continue;
						}
					} else if (action.task === "enable") {
						// Insert all config data into D1
						if (configData.length > 0) {
							await insertConfigData(env.DB, newVersion, configData);
						}

						// Clean up old version data
						const oldVersion = await getCurrentVersion(env.DB);
						if (oldVersion && oldVersion !== newVersion) {
							await deleteConfigVersion(env.DB, oldVersion);
						}

						// Enable the new version
						await setActiveVersion(env.DB, newVersion);

						// Make sure not to process any more files after this
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
			const ret = await getCurrentVersion(env.DB);
			return text(ret || "");
		}
	);
}
