import * as core from "@actions/core";
import JSON5 from "json5";
import path from "path-browserify";
import { ConditionalUpdateConfig } from "../lib/config.js";
import { parseLogic } from "../lib/Logic.js";
import { getErrorMessage } from "../lib/shared.js";
import { NodeFS } from "./nodeFS.js";

import { dirname } from "path";
import { fileURLToPath } from "url";
import { ZodError } from "zod";
const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = path.resolve(__dirname, "../../firmwares");

const VERSION_OPERATORS = new Set([
	"ver >=",
	"ver >",
	"ver <=",
	"ver <",
	"ver ===",
]);

/** Returns true if a version string has a part with a leading zero, e.g. "2.00" */
function hasLeadingZeroVersionPart(version: string): boolean {
	return version
		.split(".")
		.some((part) => part.length > 1 && part.startsWith("0"));
}

/** Recursively walks a JSON Logic object and collects version strings that have leading zeros */
function findNonSemverVersionsInLogic(logic: unknown): string[] {
	if (!logic || typeof logic !== "object") return [];
	const results: string[] = [];
	for (const [key, value] of Object.entries(logic)) {
		if (VERSION_OPERATORS.has(key)) {
			if (Array.isArray(value) && value.length >= 2) {
				const version = value[1];
				if (
					typeof version === "string" &&
					hasLeadingZeroVersionPart(version)
				) {
					results.push(version);
				}
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				results.push(...findNonSemverVersionsInLogic(item));
			}
		} else if (typeof value === "object") {
			results.push(...findNonSemverVersionsInLogic(value));
		}
	}
	return results;
}

interface ValidationResult {
	filename: string;
	errors: string[];
}

async function validateConfigFile(filePath: string): Promise<ValidationResult> {
	const relativePath = path.relative(configDir, filePath).replace(/\\/g, "/");

	const errors: string[] = [];

	try {
		const fileContent = await NodeFS.readFile(filePath);

		try {
			// Parse JSON5 content
			const definition = JSON5.parse(fileContent);

			// Create ConditionalUpdateConfig which validates the schema and runs sanity checks
			const config = new ConditionalUpdateConfig(definition);

			// Check $if conditions for non-semver versions (e.g. leading zeros like "2.00")
			for (let i = 0; i < config.upgrades.length; i++) {
				const upgrade = config.upgrades[i];
				if (upgrade.$if) {
					let logic: unknown;
					try {
						logic = parseLogic(upgrade.$if);
					} catch (e) {
						errors.push(
							`upgrades[${i}].$if is not valid logic: ${getErrorMessage(e)}`,
						);
						continue;
					}
					const nonSemverVersions =
						findNonSemverVersionsInLogic(logic);
					for (const version of nonSemverVersions) {
						errors.push(
							`upgrades[${i}].$if contains non-semver version "${version}" (has leading zeros)`,
						);
					}
				}
			}
		} catch (parseError) {
			if (
				parseError instanceof Error &&
				parseError.message.includes("issues")
			) {
				// This is a zod validation error
				errors.push(
					`Schema validation failed: ${getErrorMessage(parseError)}`,
				);
			} else if (parseError instanceof ZodError) {
				errors.push(JSON.stringify(parseError.flatten()));
			} else {
				// This could be JSON5 parsing error or other validation errors
				errors.push(
					`Validation failed: ${getErrorMessage(parseError)}`,
				);
			}
		}
	} catch (readError) {
		errors.push(`Failed to read file: ${getErrorMessage(readError)}`);
	}

	return {
		filename: relativePath,
		errors,
	};
}

void (async () => {
	try {
		console.log("🔍 Validating config files...\n");

		// Find all config files (same logic as upload.ts)
		const configFiles = (await NodeFS.readDir(configDir, true)).filter(
			(file) =>
				file.endsWith(".json") &&
				!file.endsWith("index.json") &&
				!path.basename(file).startsWith("_") &&
				!file.includes("/templates/") &&
				!file.includes("\\templates\\"),
		);

		console.log(`Found ${configFiles.length} config files to validate.`);

		const results = await Promise.all(
			configFiles.map((filePath) => validateConfigFile(filePath)),
		);

		const validFiles = results.filter(
			(result) => result.errors.length === 0,
		);
		const invalidFiles = results.filter(
			(result) => result.errors.length > 0,
		);

		console.log(`\n✅ Valid files: ${validFiles.length}`);

		if (invalidFiles.length > 0) {
			console.log(`❌ Invalid files: ${invalidFiles.length}\n`);

			for (const result of invalidFiles) {
				console.log(`📁 ${result.filename}:`);
				for (const error of result.errors) {
					console.log(`   ❌ ${error}`);
					core.error(error, { file: `firmwares/${result.filename}` });
				}
				console.log();
			}

			console.log(
				`\n💥 Found ${invalidFiles.length} invalid config files.`,
			);
			process.exit(1);
		} else {
			console.log("\n🎉 All config files are valid!");
			process.exit(0);
		}
	} catch (error) {
		console.error(
			"💥 Failed to validate config files:",
			getErrorMessage(error, true),
		);
		process.exit(1);
	}
})();
