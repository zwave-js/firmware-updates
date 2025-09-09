import { z } from "zod";

const versionSchema = z
	.string()
	.length(8)
	.regex(/[0-9a-f]{8}/);

export const createSchema = z.object({
	task: z.literal("create"),
});

export const putSchema = z.object({
	task: z.literal("put"),
	filename: z.string().min(1),
	data: z.any(),
});

export const enableSchema = z.object({
	task: z.literal("enable"),
});

export const uploadSchema = z.object({
	version: versionSchema,
	actions: z.union([createSchema, putSchema, enableSchema]).array(),
});

export type UploadPayload = z.infer<typeof uploadSchema>;
