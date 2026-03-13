import { manufacturerAccounts } from "../definitions.js";
import type { GitHubScriptContext } from "../types.mts";
import { SUBMISSION_COMMENT_TAG } from "./submission-pr.mts";

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const issue = context.payload.issue;
	if (!issue) return;

	const submitter = issue.user.login;
	const issueNumber = issue.number;
	const owner = context.repo.owner;
	const repo = context.repo.repo;

	if (manufacturerAccounts.includes(submitter)) {
		await github.rest.issues.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels: ["approved"],
		});
		try {
			await github.rest.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: "pending-approval",
			});
		} catch {
			// Label may not be present.
		}
		return;
	}

	// Check current labels — a maintainer may have already approved.
	const { data: currentIssue } = await github.rest.issues.get({
		owner,
		repo,
		issue_number: issueNumber,
	});
	const labelNames = currentIssue.labels.map((label) =>
		typeof label === "string" ? label : (label.name ?? ""),
	);
	if (labelNames.includes("approved")) {
		return;
	}

	await github.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body: `Thanks for your submission! A maintainer will review it and start processing when ready.\n${SUBMISSION_COMMENT_TAG}`,
	});
}
