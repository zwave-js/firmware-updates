import { z } from "zod";
import {
	firmwareVersionSchema,
	regionSchema,
	UpgradeInfo,
} from "./lib/configSchema";
import { ExpandRecursively, hexKeyRegex4Digits } from "./lib/shared";

/** The request schema for API versions 1...2 */
export const APIv1v2_RequestSchema = z.object({
	manufacturerId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productType: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	productId: z.string().regex(hexKeyRegex4Digits, {
		message: "Must be a hexadecimal number with 4 digits",
	}),
	firmwareVersion: firmwareVersionSchema,
});

/** The request schema for API version 3 */
export const APIv3_RequestSchema = APIv1v2_RequestSchema.merge(
	z.object({
		region: regionSchema.optional(),
	})
);

export interface APIv1v3_UpgradeMeta {
	downgrade: boolean;
	normalizedVersion: string;
}

export type APIv1_UpgradeInfo = Omit<UpgradeInfo, "channel" | "region"> &
	APIv1v3_UpgradeMeta;
export type APIv1_Response = ExpandRecursively<APIv1_UpgradeInfo[]>;

export type APIv2_UpgradeInfo = Omit<UpgradeInfo, "region"> &
	APIv1v3_UpgradeMeta;
export type APIv2_Response = ExpandRecursively<APIv2_UpgradeInfo[]>;

export type APIv3_UpgradeInfo = UpgradeInfo & APIv1v3_UpgradeMeta;
export type APIv3_Response = ExpandRecursively<APIv3_UpgradeInfo[]>;
