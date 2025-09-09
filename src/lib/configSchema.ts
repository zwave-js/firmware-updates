import { z } from "zod";
import { hexKeyRegex4Digits, isFirmwareVersion } from "./shared";

/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

export const firmwareVersionSchema = z
	.string()
	.refine(isFirmwareVersion, "Is not a valid firmware version");

export const regionSchema = z.enum([
	"europe",
	"usa",
	"australia/new zealand",
	"hong kong",
	"india",
	"israel",
	"russia",
	"china",
	"japan",
	"korea",
]);

const deviceSchema = z.object({
	brand: z.string().min(1),
	model: z.string().min(1),

	manufacturerId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productType: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),

	firmwareVersion: z
		.object({
			min: firmwareVersionSchema,
			max: firmwareVersionSchema,
		})
		.optional()
		.transform((val) => {
			if (val == undefined) {
				return {
					min: "0.0",
					max: "255.255",
				};
			}
			return val;
		}),
});

const fileSchema = z.object({
	target: z.number().min(0).optional().default(0),
	url: z.string().refine(
		(val) => {
			// Check for leading/trailing whitespace
			if (val !== val.trim()) {
				return false;
			}
			// Check if it's a valid URL
			try {
				new URL(val);
				return true;
			} catch {
				return false;
			}
		},
		(val) => ({
			message:
				val !== val.trim()
					? "URL must not have leading or trailing whitespace"
					: "Invalid url",
		})
	),
	integrity: z
		.string()
		.regex(/^sha256:[a-f0-9A-F]{64}$/, "Is not a supported hash"),
});

const upgradeBaseSchema = z.object({
	$if: z.string().min(1).optional(),
	version: firmwareVersionSchema,
	changelog: z.string().min(1),
	channel: z.enum(["stable", "beta"]).optional().default("stable"),
	region: regionSchema.optional(),
});

const upgradeSchemaMultiple = upgradeBaseSchema.merge(
	z.object({ files: z.array(fileSchema) })
);

const upgradeSchemaSingle = upgradeBaseSchema
	.merge(fileSchema)
	.transform(
		({
			$if,
			version,
			changelog,
			channel,
			region,
			target,
			integrity,
			url,
		}) => {
			// Normalize to the same format as the "multiple" variant
			return {
				...($if != undefined ? { $if } : {}),
				version,
				changelog,
				// The following two casts are necessary to not lose the literal types
				channel: channel as typeof channel,
				region: region as typeof region,
				files: [{ target, integrity, url }],
			};
		}
	);

const upgradeSchema = upgradeSchemaSingle.or(upgradeSchemaMultiple);

export const configSchema = z.object({
	devices: z.array(deviceSchema).min(1),
	upgrades: z.array(upgradeSchema).min(1),
});

export type DeviceIdentifier = z.infer<typeof deviceSchema>;
export type ConditionalUpgradeInfo = z.infer<typeof upgradeSchemaMultiple>;
export type UpgradeInfo = Omit<ConditionalUpgradeInfo, "$if">;

export type IConfig = z.infer<typeof configSchema>;
