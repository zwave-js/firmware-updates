// @ts-check

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {ReturnType<typeof import("@actions/github").getOctokit>} Github
 *
 * @typedef {typeof import("@actions/github").context} Context
 */

async function readDir(dir, recursive) {
	if (recursive) {
		/** @type {string[]} */
		const ret = [];
		try {
			const filesAndDirs = await fs.readdir(dir);
			for (const f of filesAndDirs) {
				const fullPath = path.join(dir, f);

				if ((await fs.stat(fullPath)).isDirectory()) {
					ret.push(...(await readDir(fullPath, true)));
				} else {
					ret.push(fullPath);
				}
			}
		} catch (e) {
			console.error(`Cannot read directory: "${dir}": ${e.stack}`);
		}

		return ret;
	} else {
		return fs.readdir(dir);
	}
}
/**
 * @param {{github: Github, context: Context}} param
 */
async function main(param) {
	const { github, context } = param;

	console.dir(context);

	// const firmwaresDir = path.join(github.workspace, "firmwares");

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
