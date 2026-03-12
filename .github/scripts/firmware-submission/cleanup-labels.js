// @ts-check

/// <reference path="../types.d.ts" />

const SUBMISSION_LABELS = [
	"pending-approval",
	"approved",
	"processing",
	"submitted",
	"checks-failed",
];
const { getSubmissionIssueNumberFromPR } = require("./submission-pr.cjs");

/**
 * @param {{github: Github, context: Context}} param
 */
async function main({ github, context }) {
	const owner = context.repo.owner;
	const repo = context.repo.repo;
	const issueNumber = getSubmissionIssueNumberFromPR(
		context.payload.pull_request,
		owner,
		repo,
	);
	if (issueNumber == null) return;

	let currentLabels;
	try {
		const { data } = await github.rest.issues.get({
			owner,
			repo,
			issue_number: issueNumber,
		});
		currentLabels = data.labels.map((l) =>
			typeof l === "string" ? l : (l.name ?? ""),
		);
	} catch {
		return;
	}

	for (const label of SUBMISSION_LABELS) {
		if (currentLabels.includes(label)) {
			await github.rest.issues
				.removeLabel({
					owner,
					repo,
					issue_number: issueNumber,
					name: label,
				})
				.catch(() => {});
		}
	}
}

module.exports = main;
