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
	if (!context.payload.pull_request) return;

	const pull_number = context.payload.pull_request.number;

	// console.dir(context.payload.pull_request, { depth: Infinity });

	const indexJson = await fs.readFile(
		path.join(firmwaresDir, "index.json"),
		"utf-8"
	);
	const files = JSON5.parse(indexJson).map((entry) => entry.filename);

	let errors = [];

	const prFiles = await github.paginate(
		github.rest.pulls.listFiles,
		{
			...context.repo,
			pull_number,
		},
		(response) => response.data
	);

	// Whatever the difference between "modified" and "changed" is 🤷‍♂️
	const filesToCheck = prFiles
		.filter(
			(file) =>
				file.status === "added" ||
				file.status === "modified" ||
				file.status === "changed"
		)
		.map((file) => file.filename)
		.filter((filename) => filename.startsWith("firmwares/"));

	if (filesToCheck.length === 0) {
		core.info("No firmware files changed, skipping integrity check");
		return;
	}

	for (const file of filesToCheck) {
		core.info(" ");
		core.info(`Checking download(s) for ${file}`);
		const filenameFull = path.join(firmwaresDir, file);

		// TODO: Reuse ConditionalUpdateConfig for parsing
		const { upgrades } = JSON5.parse(
			await fs.readFile(filenameFull, "utf-8")
		);

		for (const upgrade of upgrades) {
			core.info(`  -> upgrade ${upgrade.version}`);
			const upgradeFiles = upgrade.files ?? [
				{
					target: upgrade.target,
					url: upgrade.url,
					integrity: upgrade.integrity,
				},
			];

			for (const uf of upgradeFiles) {
				const { url, integrity, target = 0 } = uf;
				core.info(`    -> target ${target}, url ${url}`);

				let filename;
				let rawData;
				let hash;
				try {
					({ filename, rawData } = await downloadFirmware(url));
				} catch (e) {
					errors.push(
						`${file}: Failed to download upgrade for version ${upgrade.version}, target ${target}, url ${url}: ${e.message}`
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				core.info(`      ✅ Download successful`);

				try {
					hash = generateHash(filename, rawData);
				} catch (e) {
					errors.push(
						`${file}: Failed to generate integrity hash for version ${upgrade.version}, target ${target}, url ${url}: ${e.message}`
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				if (hash !== integrity) {
					errors.push(
						`${file}: Integrity hash mismatch for version ${upgrade.version}, target ${target}, url ${url}:
Expected: ${integrity}
Got:      ${hash}`
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				core.info(`      ✅ Integrity hash matches`);
			}
		}
	}

	if (errors.length) {
		const comment = `Checking firmware downloads and integrity hashes failed with the following errors:
${errors.join("\n\n")}`;

		await github.rest.issues.createComment({
			...context.repo,
			issue_number: pull_number,
			body: comment,
		});

		core.setFailed(comment);
	}
}

module.exports = main;