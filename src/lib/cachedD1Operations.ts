import type { D1Database } from "@cloudflare/workers-types";
import { APIv4_DeviceInfo } from "../apiDefinitions.js";
import { getCurrentVersion } from "./d1Operations.js";
import { array2hex } from "./shared.js";

const CACHE_KEY_PREFIX = "/__d1-cache/";

// Cache for 24 hours to avoid hitting D1 too often.
// Since we use the database version as part of the cache key,
// we don't need to purge them when serving a new version.
const oneDayInSeconds = 24 * 60 * 60;

/**
 * Create cache key for D1 device lookups, similar to getUpdatesCacheUrl
 */
export function getD1CacheKey(
	baseURL: string,
	filesVersion: string,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): string {
	const cacheKeySuffix = [
		filesVersion,
		manufacturerId,
		productType,
		productId,
		firmwareVersion,
	].join("/");

	return new URL(
		CACHE_KEY_PREFIX + encodeURIComponent(cacheKeySuffix),
		baseURL,
	).toString();
}

/**
 * D1-specific wrapper around getCachedResponse for device configurations.
 * Returns `null` if there is no update (cache hit) and `undefined` if cache miss.
 */
export async function getD1CachedConfig(
	baseURL: string,
	filesVersion: string,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
): Promise<APIv4_DeviceInfo | null | undefined> {
	// FIXME: Use a tagged union type to make it clearer what null (cache hit, device not in DB) and undefined (cache miss) mean
	const cacheKey = getD1CacheKey(
		baseURL,
		filesVersion,
		manufacturerId,
		productType,
		productId,
		firmwareVersion,
	);

	const cachedResponse = await getCachedResponse(cacheKey);
	if (cachedResponse) {
		try {
			return await cachedResponse.json();
		} catch {
			// Cache corruption, return undefined to indicate cache miss
			return undefined;
		}
	}

	// Cache miss
	return undefined;
}

/**
 * D1-specific wrapper around cacheResponse for device configurations
 */
export async function cacheD1Config(
	baseURL: string,
	context: ExecutionContext,
	filesVersion: string,
	manufacturerId: number | string,
	productType: number | string,
	productId: number | string,
	firmwareVersion: string,
	config: APIv4_DeviceInfo | null,
): Promise<void> {
	const cacheKey = getD1CacheKey(
		baseURL,
		filesVersion,
		manufacturerId,
		productType,
		productId,
		firmwareVersion,
	);

	const response = new Response(JSON.stringify(config), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
		},
	});

	await cacheResponse(cacheKey, context, response);
}

/**
 * Helper function similar to withCache but only returns cached response if available
 */
async function getCachedResponse(
	cacheKey: string,
): Promise<Response | undefined> {
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey, {
		ignoreMethod: true,
	});

	if (cachedResponse && cachedResponse.status === 200) {
		return cachedResponse;
	}

	return undefined;
}

/**
 * Cache a response with proper headers and ETag
 */
async function cacheResponse(
	cacheKey: string,
	context: ExecutionContext,
	response: Response,
	sMaxAge: number = oneDayInSeconds,
	maxAge: number = 60 * 60,
): Promise<void> {
	if (response.status === 200) {
		const responseBody = await response.clone().text();
		const hash = array2hex(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(responseBody),
				),
			),
		);

		// Cache the response
		response.headers.set(
			"Cache-Control",
			`public, s-maxage=${sMaxAge}, max-age=${maxAge}, stale-while-revalidate`,
		);
		response.headers.set("ETag", hash);

		const cache = caches.default;
		context.waitUntil(cache.put(cacheKey, response.clone()));
	}
}

/**
 * Cached wrapper for getCurrentVersion
 */
export async function getCurrentVersionCached(
	baseURL: string,
	context: ExecutionContext,
	db: D1Database,
): Promise<string | undefined> {
	const cacheKey = new URL(
		CACHE_KEY_PREFIX + "current-version",
		baseURL,
	).toString();

	// Try to get from cache first
	const cachedResponse = await getCachedResponse(cacheKey);
	if (cachedResponse) {
		try {
			return await cachedResponse.text();
		} catch {
			// Cache corruption, continue to database lookup
		}
	}

	// Cache miss - query database
	const version = await getCurrentVersion(db);
	if (version) {
		// Cache the result
		const response = new Response(version, {
			status: 200,
			headers: {
				"Content-Type": "text/plain",
			},
		});

		// Cache current version at the edge for 1 minute
		await cacheResponse(cacheKey, context, response, 60, 0);
	}

	return version;
}
