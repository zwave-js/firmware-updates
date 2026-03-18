import type { GitHubScriptContext } from "../types.mts";
import { getSubmissionIssueNumberFromPR } from "./submission-pr.mts";

const SUBMISSION_LABELS = [
	// Clear any post-approval state. Unmerged closes are reset to
	// "pending-approval" after these labels are removed.
	"approved",
	"processing",
	"submitted",
	"checks-failed",
];

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const pr = context.payload.pull_request;
	const owner = context.repo.owner;
	const repo = context.repo.repo;
	const issueNumber = getSubmissionIssueNumberFromPR(
		pr,
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

	if (pr?.merged || currentLabels.includes("pending-approval")) {
		return;
	}

	await github.rest.issues
		.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels: ["pending-approval"],
		})
		.catch(() => {});
}
