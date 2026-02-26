import { zodToJsonSchema } from "zod-to-json-schema";
import { configSchema } from "../lib/configSchema.js";

const jsonSchema = zodToJsonSchema(configSchema, "firmwareConfig");
console.log(JSON.stringify(jsonSchema, null, "\t"));
