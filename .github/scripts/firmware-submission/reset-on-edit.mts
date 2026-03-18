import type { GitHubScriptContext } from "../types.mts";

const POST_APPROVAL_LABELS = [
	"approved",
	"processing",
	"submitted",
	"checks-failed",
];

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const issue = context.payload.issue;
	if (!issue) return;
	if (!context.payload.changes?.body) return;

	const issueNumber = issue.number;
	const owner = context.repo.owner;
	const repo = context.repo.repo;

	console.log(
		`Issue #${issueNumber} was edited after approval, resetting labels...`,
	);

	for (const label of POST_APPROVAL_LABELS) {
		try {
			await github.rest.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: label,
			});
		} catch {
			// Label may not be present.
		}
	}

	await github.rest.issues.addLabels({
		owner,
		repo,
		issue_number: issueNumber,
		labels: ["pending-approval"],
	});
}
