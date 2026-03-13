import type { GitHubScriptContext } from "../types.mts";
import { getSubmissionIssueNumberFromPR } from "./submission-pr.mts";

const SUBMISSION_LABELS = [
	"pending-approval",
	"approved",
	"processing",
	"submitted",
	"checks-failed",
];

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const owner = context.repo.owner;
	const repo = context.repo.repo;
	const issueNumber = getSubmissionIssueNumberFromPR(
		context.payload.pull_request,
		owner,
		repo,
	);
	if (issueNumber == null) return;

	let currentLabels: string[];
	try {
		const { data } = await github.rest.issues.get({
			owner,
			repo,
			issue_number: issueNumber,
		});
		currentLabels = data.labels.map((label) =>
			typeof label === "string" ? label : (label.name ?? ""),
		);
	} catch {
		return;
	}

	for (const label of SUBMISSION_LABELS) {
		if (!currentLabels.includes(label)) {
			continue;
		}

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
