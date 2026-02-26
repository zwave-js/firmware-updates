import { array2hex } from "./shared.js";

export interface CacheOptions {
	req?: RequestInit;
	context: ExecutionContext;
	cacheKey: string | Request;
	maxAge?: number;
	sMaxAge?: number;
}

export async function withCache(
	options: CacheOptions,
	responseFactory: () => Promise<Response | null | undefined>,
): Promise<Response> {
	const { req, context, cacheKey, sMaxAge = 600, maxAge = 5 } = options;

	// Find the cache key in the cache
	const cache = caches.default;
	let response = await cache.match(cacheKey, {
		// We serve POST requests which are not cached by default
		ignoreMethod: true,
	});
	if (response) {
		if (
			req?.headers &&
			"if-none-match" in req.headers &&
			req.headers["if-none-match"] === response.headers.get("etag")
		) {
			return new Response(null, { status: 304 });
		}

		// Create a new response from the cached one, so we can modify its headers
		// Just cloning doesn't seem to be enough
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	response = (await responseFactory()) ?? new Response(null, { status: 404 });

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

		// Cache the response for 10 minutes on the server, revalidate after 5 seconds on the client
		response.headers.append(
			"Cache-Control",
			`public, s-maxage=${sMaxAge}, max-age=${maxAge}, stale-while-revalidate`,
		);
		response.headers.append("ETag", hash);
		context.waitUntil(cache.put(cacheKey, response.clone()));
	}

	return response;
}
