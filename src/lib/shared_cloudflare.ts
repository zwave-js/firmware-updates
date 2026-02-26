import { error } from "itty-router";

/** Constant-time string comparison */
export function safeCompare(expected: string, actual: string): boolean {
	const lenExpected = expected.length;
	let result = 0;

	if (lenExpected !== actual.length) {
		actual = expected;
		result = 1;
	}

	for (let i = 0; i < lenExpected; i++) {
		result |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
	}

	return result === 0;
}

export function clientError(
	message: BodyInit | Record<string, any> | undefined,
	code: number = 400,
): Response {
	return error(code, message);
}

export function serverError(
	message: BodyInit | Record<string, any>,
	code: number = 500,
): Response {
	return error(code, message);
}

export type RequestWithProps<
	U extends Record<string, unknown>[],
	T extends Request = Request,
> = U extends [infer First, ...infer Rest extends Record<string, unknown>[]]
	? RequestWithProps<Rest, T & First>
	: T;

export type ContentProps = { content: unknown };
