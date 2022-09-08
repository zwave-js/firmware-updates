import { array2hex } from "./shared";

export interface CacheOptions {
	req: Request;
	context: ExecutionContext;
	cacheKey: string | Request;
	maxAge?: number;
	sMaxAge?: number;
}

export async function withCache(
	options: CacheOptions,
	responseFactory: () => Promise<Response>
): Promise<Response> {
	const { req, context, cacheKey, sMaxAge = 600, maxAge = 5 } = options;

	// Find the cache key in the cache
	const cache = caches.default;
	let response = await cache.match(cacheKey);
	if (response) {
		if (
			req.headers.has("if-none-match") &&
			req.headers.get("if-none-match") === response.headers.get("etag")
		) {
			return new Response(null, { status: 304 });
		}
		console.log("cache hit");
		return response;
	}

	response = await responseFactory();

	if (response.status === 200) {
		const responseBody = await response.clone().text();
		const hash = array2hex(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(responseBody)
				)
			)
		);

		// Cache the response for 10 minutes on the server, revalidate after 5 seconds on the client
		response.headers.append(
			"Cache-Control",
			`public, s-maxage=${sMaxAge}, max-age=${maxAge}, stale-while-revalidate`
		);
		response.headers.append("ETag", hash);
		context.waitUntil(cache.put(cacheKey, response.clone()));
	}

	return response;
}
