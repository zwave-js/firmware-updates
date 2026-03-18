import type { GitHubScriptContext } from "../types.mts";
import {
	SUBMISSION_COMMENT_TAG,
	getSubmissionIssueNumberFromPR,
} from "./submission-pr.mts";
const SUBMISSION_LABELS = ["processing", "submitted", "checks-failed"];

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function workflowRunPassed(
	conclusion: string | null | undefined,
): boolean {
	return conclusion === "success";
}

function shouldIncludeJobInFailureSummary(
	conclusion: string | null | undefined,
): boolean {
	return (
		conclusion != null &&
		!["success", "neutral", "skipped"].includes(conclusion)
	);
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

	// If the branch was force-pushed (e.g. after an issue edit triggered
	// re-processing), ignore results from the now-stale workflow run.
	if (pr.head.sha !== run.head_sha) {
		console.log(
			`Workflow run SHA (${run.head_sha}) does not match PR head (${pr.head.sha}), skipping`,
		);
		return;
	}

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

	const { data: jobsData } = await github.rest.actions.listJobsForWorkflowRun(
		{
			owner,
			repo,
			run_id: run.id,
		},
	);
	const passed = workflowRunPassed(run.conclusion);
	const unsuccessfulJobs = jobsData.jobs.filter((job) =>
		shouldIncludeJobInFailureSummary(job.conclusion),
	);

	let commentBody: string;
	if (passed) {
		commentBody = `All checks passed on the [pull request](${pr.html_url}). A maintainer will review and merge.`;
	} else {
		const sections: string[] = [];
		for (const job of unsuccessfulJobs) {
			let errorLines = "";
			try {
				// downloadJobLogsForWorkflowRun follows the redirect and
				// returns the plain-text job log directly in `data`.
				const logResponse =
					await github.rest.actions.downloadJobLogsForWorkflowRun({
						owner,
						repo,
						job_id: job.id,
					});
				const logText = logResponse.data as unknown as string;
				const clean = logText
					.replace(/\x1B\[[0-9;]*m/g, "")
					.replace(
						/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm,
						"",
					);
				const lines = clean
					.split("\n")
					.filter(
						(line) =>
							line.includes("##[error]") ||
							line.startsWith("Error:") ||
							line.startsWith("error ") ||
							line.includes("❌"),
					);
				errorLines = lines
					.map((line) => line.replace("##[error]", "").trim())
					.filter(
						(line) =>
							line !== "Process completed with exit code 1.",
					)
					.slice(0, 50)
					.join("\n");
			} catch (error) {
				errorLines = `(Could not retrieve logs: ${getErrorMessage(error)})`;
			}
			sections.push(
				`**Job: \`${job.name}\`**\n\`\`\`\n${errorLines || "(No error output found)"}\n\`\`\``,
			);
		}
		const workflowConclusion = run.conclusion ?? "unknown";
		if (sections.length === 0) {
			commentBody = `Checks did not pass on the [pull request](${pr.html_url}). The workflow run concluded with \`${workflowConclusion}\`.`;
		} else {
			commentBody = `Checks did not pass on the [pull request](${pr.html_url}) (workflow conclusion: \`${workflowConclusion}\`):\n\n${sections.join("\n\n")}`;
		}
	}

	const existingComments = await github.paginate(
		github.rest.issues.listComments,
		{ owner, repo, issue_number: issueNumber },
	);
	const statusComments = existingComments.filter(
		(comment) =>
			comment.body?.endsWith(SUBMISSION_COMMENT_TAG) &&
			comment.user?.login === "zwave-js-bot",
	);
	for (const comment of statusComments) {
		try {
			await github.graphql(
				`mutation($id: ID!) {
					minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
						minimizedComment { isMinimized }
					}
				}`,
				{ id: comment.node_id },
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
		body: `${commentBody}\n${SUBMISSION_COMMENT_TAG}`,
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
	if (passed) {
		await removeLabel("checks-failed");
		await addLabel("submitted");
		return;
	}

	await removeLabel("submitted");
	await addLabel("checks-failed");
}
