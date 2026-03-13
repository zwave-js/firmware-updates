import type { GitHubScriptContext } from "../types.mts";
import { getSubmissionIssueNumberFromPR } from "./submission-pr.mts";

const COMMENT_TAG = "<!-- firmware-submission-status -->";
const SUBMISSION_LABELS = ["processing", "submitted", "checks-failed"];

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const run = context.payload.workflow_run;
	if (!run) return;

	const owner = context.repo.owner;
	const repo = context.repo.repo;

	let prNumber: number;
	if (run.pull_requests && run.pull_requests.length > 0) {
		prNumber = run.pull_requests[0].number;
	} else {
		const { data: prs } = await github.rest.pulls.list({
			owner,
			repo,
			state: "open",
			head: `${owner}:${run.head_branch}`,
		});
		const matched = prs.find((pr) => pr.head.sha === run.head_sha);
		if (!matched) {
			console.log("No PR found for this workflow run, skipping");
			return;
		}
		prNumber = matched.number;
	}

	const { data: pr } = await github.rest.pulls.get({
		owner,
		repo,
		pull_number: prNumber,
	});

	const issueNumber = getSubmissionIssueNumberFromPR(pr, owner, repo);
	if (issueNumber == null) {
		console.log("PR is not a bot-managed submission PR, skipping");
		return;
	}

	const { data: issue } = await github.rest.issues.get({
		owner,
		repo,
		issue_number: issueNumber,
	});
	const labelNames = issue.labels.map((label) =>
		typeof label === "string" ? label : (label.name ?? ""),
	);
	if (!SUBMISSION_LABELS.some((label) => labelNames.includes(label))) {
		console.log("Issue does not have a submission label, skipping");
		return;
	}

	const { data: jobsData } = await github.rest.actions.listJobsForWorkflowRun({
		owner,
		repo,
		run_id: run.id,
	});
	const failedJobs = jobsData.jobs.filter((job) => job.conclusion === "failure");

	let commentBody: string;
	if (failedJobs.length === 0) {
		commentBody = `All checks passed on the [pull request](${pr.html_url}). A maintainer will review and merge.`;
	} else {
		const sections: string[] = [];
		for (const job of failedJobs) {
			let errorLines = "";
			try {
				const logResponse =
					await github.rest.actions.downloadJobLogsForWorkflowRun({
						owner,
						repo,
						job_id: job.id,
					});
				const logText = await fetch(logResponse.url).then((response) =>
					response.text(),
				);
				const clean = logText
					.replace(/\x1B\[[0-9;]*m/g, "")
					.replace(
						/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm,
						"",
					);
				const lines = clean.split("\n").filter(
					(line) =>
						line.includes("##[error]") ||
						line.startsWith("Error:") ||
						line.startsWith("error "),
				);
				errorLines = lines.slice(0, 50).join("\n");
			} catch (error) {
				errorLines = `(Could not retrieve logs: ${getErrorMessage(error)})`;
			}
			sections.push(
				`**Job: \`${job.name}\`**\n\`\`\`\n${errorLines || "(No error output found)"}\n\`\`\``,
			);
		}
		commentBody = `The following checks failed on the [pull request](${pr.html_url}):\n\n${sections.join("\n\n")}`;
	}

	const existingComments = await github.paginate(
		github.rest.issues.listComments,
		{ owner, repo, issue_number: issueNumber },
	);
	const existing = existingComments.find(
		(comment) =>
			comment.body?.endsWith(COMMENT_TAG) &&
			comment.user?.login === "zwave-js-bot",
	);
	if (existing) {
		try {
			await github.graphql(
				`mutation($id: ID!) {
					minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
						minimizedComment { isMinimized }
					}
				}`,
				{ id: existing.node_id },
			);
		} catch (error) {
			console.log(
				"Could not minimize existing comment:",
				getErrorMessage(error),
			);
		}
	}

	await github.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body: `${commentBody}\n${COMMENT_TAG}`,
	});

	const addLabel = async (label: string): Promise<void> => {
		try {
			await github.rest.issues.addLabels({
				owner,
				repo,
				issue_number: issueNumber,
				labels: [label],
			});
		} catch {}
	};

	const removeLabel = async (label: string): Promise<void> => {
		if (!labelNames.includes(label)) {
			return;
		}
		try {
			await github.rest.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: label,
			});
		} catch {}
	};

	await removeLabel("processing");
	if (failedJobs.length === 0) {
		await addLabel("submitted");
		return;
	}

	await removeLabel("submitted");
	await addLabel("checks-failed");
}
