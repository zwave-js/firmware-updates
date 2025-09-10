import semver from "semver";

export const hexKeyRegex4Digits = /^0x[a-f0-9]{4}$/;
export const hexKeyRegex2Digits = /^0x[a-f0-9]{2}$/;
export const firmwareVersionRegex = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;

export function isFirmwareVersion(val: any): val is string {
	return (
		typeof val === "string" &&
		firmwareVersionRegex.test(val) &&
		val
			.split(".")
			.map((str) => parseInt(str, 10))
			.every((num) => num >= 0 && num <= 255) &&
		!!semver.valid(padVersion(val))
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
export function padVersion(version: string, suffix: string = "0"): string {
	if (version.split(".").length === 3) return version;
	return version + `.${suffix}`;
}

export function compareVersions(v1: string, v2: string): -1 | 0 | 1 {
	return semver.compare(padVersion(v1), padVersion(v2));
}

/**
 * Normalizes a firmware version string (x.y.z where x,y,z are 0-255) into a single integer for efficient comparison.
 * This allows direct integer comparison in SQL queries instead of string-based semver comparison.
 * @param version Version string in format "x.y" or "x.y.z"
 * @returns Normalized version as integer
 */
export function versionToNumber(version: string): number {
	const parts = version.split(".").map((p) => parseInt(p, 10));
	return parts[0] * 256 * 256 + parts[1] * 256 + (parts[2] ?? 0);
}

// expands object types recursively
export type ExpandRecursively<T> = T extends object
	? T extends infer O
		? { [K in keyof O]: ExpandRecursively<O[K]> }
		: never
	: T;

export function array2hex(arr: Uint8Array): string {
	return [...arr].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hex2array(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
	const ret = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		ret[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return ret;
}
