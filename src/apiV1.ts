import { z } from "zod";
import { firmwareVersionSchema, UpgradeInfo } from "./lib/configSchema";
import { ExpandRecursively, hexKeyRegex4Digits } from "./lib/shared";

export const APIv1_RequestSchema = z.object({
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

export type APIv1_UpgradeInfo = UpgradeInfo & APIv1_UpgradeMeta;

export interface APIv1_UpgradeMeta {
	downgrade: boolean;
	normalizedVersion: string;
}

export type APIv1_Response = ExpandRecursively<APIv1_UpgradeInfo[]>;
