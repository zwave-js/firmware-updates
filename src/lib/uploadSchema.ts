import { z } from "zod";

export const clearSchema = z.object({
	task: z.literal("clear"),
});

export const putSchema = z.object({
	task: z.literal("put"),
	filename: z.string().min(1),
	data: z.object({}).catchall(z.any()),
});

export const uploadSchema = z.array(clearSchema.or(putSchema));
