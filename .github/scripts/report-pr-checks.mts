import {
	deleteExistingStatusComments,
	getSubmissionIssueNumberFromPR,
	postStatusComment,
} from "./firmware-submission/submission-pr.mts";
import type { GitHubClient, GitHubScriptContext } from "./types.mts";
const SUBMISSION_LABELS = ["processing", "submitted", "checks-failed"];
const FIRMWARE_DEFINITION_FILE_REGEX = /^firmwares\/[^/]+\/[^/]+\.json$/;

interface PullRequestSource {
	head?: {
		repo?: {
			full_name?: string;
		} | null;
	};
}

export function shouldReportChecksForDirectPR(
	pr: PullRequestSource,
	owner: string,
	repo: string,
	changedFiles: readonly string[],
): boolean {
	return (
		pr.head?.repo?.full_name != null &&
		pr.head.repo.full_name !== `${owner}/${repo}` &&
		changedFiles.some((filename) =>
			FIRMWARE_DEFINITION_FILE_REGEX.test(filename)
		)
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatCodeBlock(content: string): string {
	const longestBacktickRun = (content.match(/`+/g) ?? []).reduce(
		(longest, run) => Math.max(longest, run.length),
		2,
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	return `${fence}\n${content}\n${fence}`;
}

export function extractErrorOutput(logText: string): string {
	const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;
	const lines = logText.replace(/\x1B\[[0-9;]*m/g, "").split("\n");
	const errorBlocks: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index];
		const line = rawLine.replace(timestamp, "");

		if (line.includes("##[error]")) {
			const block = [line.replace("##[error]", "").trim()];
			while (
				index + 1 < lines.length &&
				!timestamp.test(lines[index + 1])
			) {
				block.push(lines[++index].trimEnd());
			}
			errorBlocks.push(block.join("\n").trim());
		} else if (
			line.startsWith("Error:") ||
			line.startsWith("error ") ||
			line.includes("❌")
		) {
			errorBlocks.push(line.trim());
		}
	}

	return errorBlocks
		.filter(
			(block) => block && block !== "Process completed with exit code 1.",
		)
		.slice(0, 50)
		.join("\n\n");
}

export function workflowRunPassed(
	conclusion: string | null | undefined,
): boolean {
	return conclusion === "success";
}

export async function publishCheckStatus(
	github: GitHubClient,
	owner: string,
	repo: string,
	prNumber: number,
	issueNumber: number | null,
	passed: boolean,
	commentBody: string,
): Promise<void> {
	const commentTarget = issueNumber ?? prNumber;
	if (passed && issueNumber == null) {
		await deleteExistingStatusComments(
			github,
			owner,
			repo,
			commentTarget,
		);
		return;
	}

	await postStatusComment(github, owner, repo, commentTarget, commentBody);
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

	let prNumber: number | undefined;
	if (run.pull_requests && run.pull_requests.length > 0) {
		prNumber = run.pull_requests[0].number;
	} else {
		const prs = await github.paginate(github.rest.pulls.list, {
			owner,
			repo,
			state: "open",
			head: `${run.head_repository.owner.login}:${run.head_branch}`,
		});
		prNumber = prs.find(
			(pr) =>
				pr.head.sha === run.head_sha &&
				pr.head.ref === run.head_branch &&
				pr.head.repo?.full_name === run.head_repository.full_name,
		)?.number;
	}
	if (prNumber == null) {
		console.log("No PR found for this workflow run, skipping");
		return;
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
	// Preserve issue-generated submission reporting; scope direct PR comments to external firmware definitions
	if (issueNumber == null) {
		const changedFiles = await github.paginate(github.rest.pulls.listFiles, {
			owner,
			repo,
			pull_number: prNumber,
		});
		if (
			!shouldReportChecksForDirectPR(
				pr,
				owner,
				repo,
				changedFiles.map((file) => file.filename),
			)
		) {
			console.log(
				"PR is not an external firmware definition contribution, skipping",
			);
			return;
		}
	}

	let labelNames: string[] = [];
	if (issueNumber != null) {
		const { data: issue } = await github.rest.issues.get({
			owner,
			repo,
			issue_number: issueNumber,
		});
		labelNames = issue.labels.map((label) =>
			typeof label === "string" ? label : (label.name ?? ""),
		);
		if (!SUBMISSION_LABELS.some((label) => labelNames.includes(label))) {
			console.log("Issue does not have a submission label, skipping");
			return;
		}
	}

	const jobs = await github.paginate(
		github.rest.actions.listJobsForWorkflowRun,
		{
			owner,
			repo,
			run_id: run.id,
		},
	);
	const passed = workflowRunPassed(run.conclusion);
	const unsuccessfulJobs = jobs.filter((job) =>
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
				const logResponse =
					await github.rest.actions.downloadJobLogsForWorkflowRun({
						owner,
						repo,
						job_id: job.id,
					});
				const logText = logResponse.data as unknown as string;
				errorLines = extractErrorOutput(logText);
			} catch (error) {
				errorLines = `(Could not retrieve logs: ${getErrorMessage(error)})`;
			}
			const output = `Job: ${job.name}

${errorLines || "(No error output found)"}`;
			sections.push(
				`**Failed job: [View logs](${job.html_url})**\n\n${formatCodeBlock(output)}`,
			);
		}
		const workflowConclusion = run.conclusion ?? "unknown";
		if (sections.length === 0) {
			commentBody = `Checks did not pass on the [pull request](${pr.html_url}). The workflow run concluded with \`${workflowConclusion}\`.`;
		} else {
			commentBody = `Checks did not pass on the [pull request](${pr.html_url}) (workflow conclusion: \`${workflowConclusion}\`):\n\n${sections.join("\n\n")}`;
		}
	}

	await publishCheckStatus(
		github,
		owner,
		repo,
		prNumber,
		issueNumber,
		passed,
		commentBody,
	);

	if (issueNumber == null) return;

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
