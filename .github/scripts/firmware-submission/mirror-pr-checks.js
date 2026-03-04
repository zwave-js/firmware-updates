// @ts-check

/// <reference path="../types.d.ts" />

const COMMENT_TAG = "<!-- firmware-submission-status -->";
const SUBMISSION_LABELS = ["processing", "submitted", "checks-failed"];

/**
 * @param {{github: Github, context: Context}} param
 */
async function main({ github, context }) {
	const run = context.payload.workflow_run;
	const owner = context.repo.owner;
	const repo = context.repo.repo;

	// Find the PR linked to this workflow run
	let prNumber;
	if (run.pull_requests && run.pull_requests.length > 0) {
		prNumber = run.pull_requests[0].number;
	} else {
		// Fall back to searching by head SHA
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
	const issueMatch = (pr.body || "").match(/Closes #(\d+)/);
	if (!issueMatch) {
		console.log("PR body does not reference a submission issue, skipping");
		return;
	}

	const issueNumber = parseInt(issueMatch[1], 10);

	// Verify this is a bot-managed submission issue
	const { data: issue } = await github.rest.issues.get({
		owner,
		repo,
		issue_number: issueNumber,
	});
	const labelNames = issue.labels.map((l) =>
		typeof l === "string" ? l : l.name ?? "",
	);
	if (!SUBMISSION_LABELS.some((l) => labelNames.includes(l))) {
		console.log("Issue does not have a submission label, skipping");
		return;
	}

	// List jobs for this workflow run
	const { data: jobsData } = await github.rest.actions.listJobsForWorkflowRun(
		{ owner, repo, run_id: run.id },
	);
	const failedJobs = jobsData.jobs.filter((j) => j.conclusion === "failure");

	// Build comment content
	let commentBody;
	if (failedJobs.length === 0) {
		commentBody = `✅ All checks passed on the [pull request](${pr.html_url}). A maintainer will review and merge.`;
	} else {
		const sections = [];
		for (const job of failedJobs) {
			let errorLines = "";
			try {
				const logResponse =
					await github.rest.actions.downloadJobLogsForWorkflowRun({
						owner,
						repo,
						job_id: job.id,
					});
				const logText = await fetch(logResponse.url).then((r) => r.text());
				const clean = logText
					.replace(/\x1B\[[0-9;]*m/g, "")
					.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm, "");
				const lines = clean
					.split("\n")
					.filter(
						(line) =>
							line.includes("##[error]") ||
							line.startsWith("Error:") ||
							line.startsWith("error "),
					);
				errorLines = lines.slice(0, 50).join("\n");
			} catch (e) {
				errorLines = `(Could not retrieve logs: ${e.message})`;
			}
			sections.push(
				`**Job: \`${job.name}\`**\n\`\`\`\n${errorLines || "(No error output found)"}\n\`\`\``,
			);
		}
		commentBody = `❌ The following checks failed on the [pull request](${pr.html_url}):\n\n${sections.join("\n\n")}`;
	}

	// Minimize existing bot status comment
	const existingComments = await github.paginate(
		github.rest.issues.listComments,
		{ owner, repo, issue_number: issueNumber },
	);
	const existing = existingComments.find(
		(c) => c.body?.endsWith(COMMENT_TAG) && c.user?.login === "zwave-js-bot",
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
		} catch (e) {
			console.log("Could not minimize existing comment:", e.message);
		}
	}

	// Post new comment
	await github.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body: commentBody + "\n" + COMMENT_TAG,
	});

	// Update labels
	/** @param {string} label */
	const addLabel = async (label) => {
		try {
			await github.rest.issues.addLabels({
				owner,
				repo,
				issue_number: issueNumber,
				labels: [label],
			});
		} catch {}
	};
	/** @param {string} label */
	const removeLabel = async (label) => {
		if (labelNames.includes(label)) {
			try {
				await github.rest.issues.removeLabel({
					owner,
					repo,
					issue_number: issueNumber,
					name: label,
				});
			} catch {}
		}
	};

	await removeLabel("processing");
	if (failedJobs.length === 0) {
		await addLabel("submitted");
	} else {
		await removeLabel("submitted");
		await addLabel("checks-failed");
	}
}

module.exports = main;
