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

// expands object types recursively
export type ExpandRecursively<T> = T extends object
	? T extends infer O
		? { [K in keyof O]: ExpandRecursively<O[K]> }
		: never
	: T;
