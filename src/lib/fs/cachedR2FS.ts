import type { FileSystem } from "./filesystem";

// We cache read results in KV for 24 hours as a compromise between duplicating
// storage and read performance. Since files are static for each version,
// outdated files will automatically be deleted.
const oneDayInSeconds = 24 * 60 * 60;

export async function getFilesVersion(
	bucket: R2Bucket,
	kv: KVNamespace
): Promise<string | undefined> {
	const cacheKey = "version";
	const cached = await kv.get(cacheKey, {
		// cache at the edge for 1 minute
		cacheTtl: 60,
	});
	if (cached) return cached;

	const versionFile = await bucket.get(cacheKey);
	if (!versionFile) return;

	const version = await versionFile.text();

	// Cache result in KV for 24 hours. This will be purged on upload.
	await kv.put(cacheKey, version, {
		expirationTtl: oneDayInSeconds,
	});

	return version;
}

export function createCachedR2FS(
	bucket: R2Bucket,
	kv: KVNamespace,
	version: string
): FileSystem {
	const FILE_PREFIX = `${version}:file:`;
	const FILE_CACHE_KEY = (file: string) => `${FILE_PREFIX}${file}`;
	const READDIR_CACHE_KEY = (dir: string, recursive: boolean) =>
		`${version}:readdir:${recursive}:${dir}`;
	const ret: FileSystem = {
		async writeFile(file, data) {
			// WARNING: This does not invalidate readdir results!
			// DO NOT write versioned files after reading them.
			const cacheKey = FILE_CACHE_KEY(file);
			await bucket.put(cacheKey, data);
			await kv.delete(cacheKey);
		},
		async readFile(file) {
			// Try to read from KV first
			const cacheKey = FILE_CACHE_KEY(file);
			const cached = await kv.get(cacheKey, {
				// cache at the edge for 24 hours
				cacheTtl: oneDayInSeconds,
			});
			if (cached) return cached;

			// Not found, read from R2 Bucket
			const obj = await bucket.get(cacheKey);
			if (!obj) {
				throw new Error(`File not found in R2: ${file}`);
			}
			const ret = await obj.text();

			// Cache result in KV for 24 hours.
			await kv.put(cacheKey, ret, {
				expirationTtl: oneDayInSeconds,
			});

			return ret;
		},
		async readDir(dir, recursive) {
			let truncated: boolean;
			let cursor: R2ListOptions["cursor"];

			if (!dir.endsWith("/")) dir += "/";

			const cacheKey = READDIR_CACHE_KEY(dir, recursive);
			const cached = await kv.get<string[]>(cacheKey, {
				type: "json",
				// cache at the edge for 24 hours
				cacheTtl: oneDayInSeconds,
			});
			if (cached) return cached;

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
					...next.objects.map((o) => o.key.slice(FILE_PREFIX.length))
				);
				truncated = next.truncated;
			} while (truncated);

			// Cache result in KV for 24 hours.
			await kv.put(cacheKey, JSON.stringify(ret), {
				expirationTtl: oneDayInSeconds,
			});
			return ret;
		},
		async deleteDir(dir) {
			if (!dir.endsWith("/")) dir += "/";

			const filesInDir = await this.readDir(dir, true);
			for (const file of filesInDir) {
				const cacheKey = FILE_CACHE_KEY(file);
				await bucket.delete(cacheKey);
				await kv.delete(cacheKey);
			}
			// purge cache
			await kv.delete(READDIR_CACHE_KEY(dir, true));
			await kv.delete(READDIR_CACHE_KEY(dir, false));
		},
	};
	return ret;
}
