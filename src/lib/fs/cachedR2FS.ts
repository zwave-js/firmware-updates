import { CacheOptions, withCache } from "../cache";
import type { FileSystem } from "./filesystem";

// We cache read results for 24 hours to avoid hitting R2 too often.
// Since files are versioned and the version is included in the cache key,
// we don't need to purge them when serving a new version.
const oneDayInSeconds = 24 * 60 * 60;

const CACHE_KEY_PREFIX = "/__r2-cache/";

async function objectWithCache(
	baseURL: string,
	key: string,
	context: ExecutionContext,
	bucket: R2Bucket,
	cacheOptions?: Omit<CacheOptions, "context" | "cacheKey">
): Promise<Response | undefined> {
	const cacheKey = new URL(
		CACHE_KEY_PREFIX + encodeURIComponent(key),
		baseURL
	).toString();
	const response = await withCache(
		{
			context,
			cacheKey,
			...cacheOptions,
		},
		async () => {
			return new Response((await bucket.get(key))?.body);
		}
	);

	if (!response.body) return;
	return response;
}

function purgeCache(
	baseURL: string,
	context: ExecutionContext,
	cacheKeySuffix: string
): void {
	const cache = caches.default;
	const cacheKey = new URL(
		CACHE_KEY_PREFIX + encodeURIComponent(cacheKeySuffix),
		baseURL
	).toString();
	context.waitUntil(
		cache.delete(cacheKey, {
			ignoreMethod: true,
		})
	);
}

export async function getFilesVersion(
	baseURL: string,
	context: ExecutionContext,
	bucket: R2Bucket
): Promise<string | undefined> {
	const filename = "version";
	const file = await objectWithCache(baseURL, filename, context, bucket, {
		// cache the current version at the edge for 1 minute
		sMaxAge: 60,
	});
	return file?.text();
}

export async function putFilesVersion(
	baseURL: string,
	context: ExecutionContext,
	bucket: R2Bucket,
	version: string
): Promise<void> {
	const filename = "version";
	await bucket.put(filename, version);
	purgeCache(baseURL, context, filename);
}

export function createCachedR2FS(
	baseURL: string,
	context: ExecutionContext,
	bucket: R2Bucket,
	version: string
): FileSystem {
	const FILE_PREFIX = `${version}:file:`;
	const FILE_OBJ_KEY = (file: string) => `${FILE_PREFIX}${file}`;
	const READDIR_OBJ_KEY = (dir: string, recursive: boolean) =>
		`${version}:readdir:${recursive}:${dir}`;
	const ret: FileSystem = {
		async writeFile(file, data) {
			// WARNING: This does not invalidate readdir results!
			// DO NOT write versioned files after reading a directory.
			const objKey = FILE_OBJ_KEY(file);
			await bucket.put(objKey, data);
			purgeCache(baseURL, context, objKey);
		},
		async readFile(file) {
			// Try to read from KV first
			const objKey = FILE_OBJ_KEY(file);
			const obj = await objectWithCache(
				baseURL,
				objKey,
				context,
				bucket,
				{
					// cache at the edge for 24 hours
					sMaxAge: oneDayInSeconds,
				}
			);
			if (!obj) {
				throw new Error(`File not found in R2: ${file}`);
			}
			return obj.text();
		},
		async readDir(dir, recursive) {
			let truncated: boolean;
			let cursor: R2ListOptions["cursor"];

			if (!dir.endsWith("/")) dir += "/";

			const cacheKey = new URL(
				CACHE_KEY_PREFIX +
					encodeURIComponent(READDIR_OBJ_KEY(dir, recursive)),
				baseURL
			).toString();

			const response = await withCache(
				{
					context,
					cacheKey,
					// Cache list result at the edge for 24 hours
					sMaxAge: oneDayInSeconds,
				},
				async () => {
					const options: R2ListOptions = {
						prefix: `${FILE_PREFIX}${dir}`,
					};
					if (!recursive) {
						options.delimiter = "/";
					}

					const ret: string[] = [];
					do {
						const next = await bucket.list({ ...options, cursor });
						ret.push(
							...next.objects.map((o) =>
								o.key.slice(FILE_PREFIX.length)
							)
						);
						truncated = next.truncated;
					} while (truncated);

					return new Response(JSON.stringify(ret), {
						status: 200,
					});
				}
			);
			return response.json();
		},
		async deleteDir(dir) {
			if (!dir.endsWith("/")) dir += "/";

			const filesInDir = await this.readDir(dir, true);
			for (const file of filesInDir) {
				const objKey = FILE_OBJ_KEY(file);
				await bucket.delete(objKey);
			}
		},
	};
	return ret;
}
