// @ts-check

const fs = require("node:fs/promises");
const path = require("node:path");
const JSON5 = require("json5");
const {
	downloadFirmware,
	generateHash,
} = require("@zwave-js/firmware-integrity");

/**
 * @typedef {ReturnType<typeof import("@actions/github").getOctokit>} Github
 *
 * @typedef {typeof import("@actions/github").context} Context
 *
 * @typedef {typeof import("@actions/core")} Core
 */

const workspaceRoot = path.join(__dirname, "../..");
const firmwaresDir = path.join(workspaceRoot, "firmwares");

/**
 * @param {{github: Github, context: Context, core: Core}} param
 */
async function main(param) {
	const { github, context, core } = param;

	console.dir(context.payload.pull_request, { depth: Infinity });

	const indexJson = await fs.readFile(
		path.join(firmwaresDir, "index.json"),
		"utf-8"
	);
	const files = JSON5.parse(indexJson).map((entry) => entry.filename);

	let errors = [];

	for (const file of files) {
		const filenameFull = path.join(firmwaresDir, file);
		// TODO: Filter based on changed files (in PRs)

		// TODO: Reuse ConditionalUpdateConfig for parsing
		const { upgrades } = JSON5.parse(
			await fs.readFile(filenameFull, "utf-8")
		);

		for (const upgrade of upgrades) {
			const upgradeFiles = upgrade.files ?? [
				{
					target: upgrade.target,
					url: upgrade.url,
					integrity: upgrade.integrity,
				},
			];

			for (const uf of upgradeFiles) {
				const { url, integrity, target = 0 } = uf;
				let filename;
				let rawData;
				let hash;
				try {
					({ filename, rawData } = await downloadFirmware(url));
				} catch (e) {
					errors.push(
						`${file}: Failed to download upgrade for version ${upgrade.version}, target ${target}, url ${url}: ${e.message}`
					);
					continue;
				}

				try {
					hash = generateHash(filename, rawData);
				} catch (e) {
					errors.push(
						`${file}: Failed to generate integrity hash for version ${upgrade.version}, target ${target}, url ${url}: ${e.message}`
					);
					continue;
				}

				if (hash !== integrity) {
					errors.push(
						`${file}: Integrity hash mismatch for version ${upgrade.version}, target ${target}, url ${url}:
Expected: ${integrity}
Got:      ${hash}`
					);
					continue;
				}
			}
		}
	}

	if (errors.length) {
		core.setFailed(`Check had the following errors:
${errors.join("\n\n")}`);
	}

	// if (message) {
	// 	// Make a new one otherwise
	// 	await github.rest.issues.createComment({
	// 		...options,
	// 		issue_number: context.issue.number,
	// 		body: message,
	// 	});
	// }
}

module.exports = main;
