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

const workspaceRoot = path.resolve(__dirname, "../..");

const COMMENT_TAG = "<!-- integrity-check -->";

/**
 * @param {{github: Github, context: Context, core: Core}} param
 */
async function main(param) {
	const { github, context, core } = param;
	if (!context.payload.pull_request) return;

	const deleteOldComments = async () => {
		try {
			const existingComments = await github.paginate(
				github.rest.issues.listComments,
				{
					...context.repo,
					issue_number: pull_number,
				},
				(response) => response.data
			);
			// core.info("existing comments: " + JSON.stringify(existingComments));

			for (const comment of existingComments) {
				if (
					comment.body?.endsWith(COMMENT_TAG) &&
					comment.user?.login === "github-actions[bot]"
				) {
					await github.rest.issues
						.deleteComment({
							...context.repo,
							comment_id: comment.id,
						})
						.catch(() => {});
				}
			}
		} catch (e) {
			// Ignore
			// core.info(`Failed to delete existing comments: ${e.stack}`);
		}
	};

	const pull_number = context.payload.pull_request.number;

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
		.filter(
			(filename) =>
				filename.startsWith("firmwares/") &&
				filename.endsWith(".json") &&
				!path.basename(filename).startsWith("_")
		);

	if (filesToCheck.length === 0) {
		core.info("No firmware files changed, skipping integrity check");

		await deleteOldComments();

		return;
	}

	for (const file of filesToCheck) {
		core.info(" ");
		core.info(`Checking download(s) for ${file}`);
		const filenameFull = path.join(workspaceRoot, file);

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

				const errorPrefix = `**${file}**, version **${upgrade.version}**, target **${target}**`;

				try {
					({ filename, rawData } = await downloadFirmware(url));
				} catch (e) {
					errors.push(
						`${errorPrefix}
Failed to download ${url}
${e.message}`
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				core.info(`      ✅ Download successful`);

				try {
					hash = generateHash(filename, rawData);
				} catch (e) {
					errors.push(
						`${errorPrefix}
Failed to generate integrity hash
${e.message}`
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				if (hash !== integrity) {
					errors.push(
						`${errorPrefix}
Integrity hash mismatch
\`\`\`diff
Expected: ${integrity}
Got:      ${hash}
\`\`\``
					);
					core.error(errors[errors.length - 1]);
					continue;
				}

				core.info(`      ✅ Integrity hash matches`);
			}
		}
	}

	await deleteOldComments();

	if (errors.length) {
		const comment = `### Checking firmware downloads and integrity hashes had ${
			errors.length
		} error${errors.length !== 1 ? "s" : ""}
		
${errors.join("\n\n---\n\n")}`;

		await github.rest.issues.createComment({
			...context.repo,
			issue_number: pull_number,
			body: comment + "\n" + COMMENT_TAG,
		});

		core.setFailed(comment);
	}
}

module.exports = main;
