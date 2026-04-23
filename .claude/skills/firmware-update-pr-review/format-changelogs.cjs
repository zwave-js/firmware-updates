#!/usr/bin/env node
// Run the firmware-submission changelog formatting pipeline against every
// `changelog` entry in one or more firmware definition files, and print any
// strings that would change. Match the pipeline used in
// `.github/scripts/firmware-submission/process-submission.mts`.
//
// Usage:
//   node .claude/skills/firmware-update-pr-review/format-changelogs.cjs \
//        firmwares/<vendor>/<file>.json [more.json ...]
//
// For each changelog entry, prints BEFORE / AFTER when the pipeline output
// differs from the source. Silent on unchanged entries.

const fs = require("fs");
const path = require("path");
const JSON5 = require("json5");
const prettier = require("prettier");

async function formatOne(raw, prettierConfig) {
	const normalized = raw.trim().replace(/\r\n/g, "\n");
	try {
		const out = await prettier.format(normalized, {
			...prettierConfig,
			parser: "markdown",
		});
		return out.trim();
	} catch {
		return normalized;
	}
}

async function processFile(absPath) {
	const cfg = (await prettier.resolveConfig(absPath)) ?? {};
	const raw = fs.readFileSync(absPath, "utf8");
	const parsed = JSON5.parse(raw);
	const upgrades = parsed.upgrades ?? [];
	let anyDiff = false;
	for (let i = 0; i < upgrades.length; i++) {
		const u = upgrades[i];
		if (typeof u.changelog !== "string") continue;
		const formatted = await formatOne(u.changelog, cfg);
		if (formatted !== u.changelog) {
			if (!anyDiff) {
				console.log(`\n### ${absPath}`);
				anyDiff = true;
			}
			const label = `upgrades[${i}] version=${u.version ?? "?"}${u.region ? ` region=${u.region}` : ""}`;
			console.log(`\n--- ${label} ---`);
			console.log("BEFORE:", JSON.stringify(u.changelog));
			console.log("AFTER: ", JSON.stringify(formatted));
		}
	}
	if (!anyDiff) {
		console.log(`# ${absPath}: no pipeline diffs`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error(
			"Usage: node format-changelogs.cjs <firmware-file.json> [more.json ...]",
		);
		process.exit(2);
	}
	for (const a of args) {
		await processFile(path.resolve(a));
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
