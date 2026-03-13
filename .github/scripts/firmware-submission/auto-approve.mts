import { manufacturerAccounts } from "../definitions.js";
import type { GitHubScriptContext } from "../types.mts";

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
		return;
	}

	await github.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body: "Thanks for your submission! A maintainer will review it and start processing when ready.",
	});
}
