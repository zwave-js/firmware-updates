// @ts-check

/// <reference path="../types.d.ts" />

const { manufacturerAccounts } = require("../definitions");

/**
 * @param {{github: Github, context: Context}} param
 */
async function main({ github, context }) {
	if (!context.payload.issue) return;
	const submitter = context.payload.issue.user.login;
	const issueNumber = context.payload.issue.number;
	const owner = context.repo.owner;
	const repo = context.repo.repo;

	if (manufacturerAccounts.includes(submitter)) {
		await github.rest.issues.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels: ["approved"],
		});
	} else {
		await github.rest.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body: "Thanks for your submission! A maintainer will review it and start processing when ready.",
		});
	}
}

module.exports = main;
