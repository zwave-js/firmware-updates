import { error } from "itty-router-extras";

export const hexKeyRegex4Digits = /^0x[a-f0-9]{4}$/;
export const hexKeyRegex2Digits = /^0x[a-f0-9]{2}$/;
export const firmwareVersionRegex = /^\d{1,3}\.\d{1,3}$/;

export function isFirmwareVersion(val: any): val is string {
	return (
		typeof val === "string" &&
		firmwareVersionRegex.test(val) &&
		val
			.split(".")
			.map((str) => parseInt(str, 10))
			.every((num) => num >= 0 && num <= 255)
	);
}

export interface FirmwareVersionRange {
	min: string;
	max: string;
}

export interface DeviceID {
	manufacturerId: number;
	productType: number;
	productId: number;
	firmwareVersion: string;
}

export function getErrorMessage(e: unknown, includeStack?: boolean): string {
	if (e instanceof Error)
		return includeStack && e.stack ? e.stack : e.message;
	return String(e);
}

/**
 * Formats an ID as a 4-digit lowercase hexadecimal string, to guarantee a representation that matches the Z-Wave specs.
 * This is meant to be used to display manufacturer ID, product type and product ID, etc.
 */
export function formatId(id: number | string): string {
	id = typeof id === "number" ? id.toString(16) : id;
	id = id.replace(/^0x/, "");
	return "0x" + id.padStart(4, "0").toLowerCase();
}

/** Pads a firmware version string, so it can be compared with semver */
export function padVersion(version: string): string {
	if (version.split(".").length === 3) return version;
	return version + ".0";
}

export function array2hex(arr: Uint8Array): string {
	return [...arr].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hex2array(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
	const ret = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		ret[i / 2] = parseInt(hex.substr(i, 2), 16);
	}
	return ret;
}

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

// expands object types recursively
export type ExpandRecursively<T> = T extends object
	? T extends infer O
		? { [K in keyof O]: ExpandRecursively<O[K]> }
		: never
	: T;

export function clientError(
	message: BodyInit | Record<string, any>,
	code: number = 400
): Response {
	return error(code, message);
}

export function serverError(
	message: BodyInit | Record<string, any>,
	code: number = 500
): Response {
	return error(code, message);
}

export type RequestWithProps<
	U extends Record<string, unknown>[],
	T extends Request = Request
> = U extends [infer First, ...infer Rest extends Record<string, unknown>[]]
	? RequestWithProps<Rest, T & First>
	: T;

export type ContentProps = { content: unknown };
