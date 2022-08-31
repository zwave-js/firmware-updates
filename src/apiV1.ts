import { z } from "zod";
import { firmwareVersionSchema, UpgradeInfo } from "./lib/configSchema";
import { ExpandRecursively, hexKeyRegex4Digits } from "./lib/shared_safe";

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

export type APIv1_Response = ExpandRecursively<UpgradeInfo[]>;
