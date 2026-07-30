import type { GitHubScriptContext } from "./types.mts";

const COMMENT_TAG = "<!-- integrity-check -->";
const INTEGRITY_JOB_NAME = "Firmware integrity";

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const run = context.payload.workflow_run;
	if (!run) return;

	let pullRequestNumber = run.pull_requests?.[0]?.number;
	if (pullRequestNumber == null) {
		const openPullRequests = await github.paginate(
			github.rest.pulls.list,
			{
				...context.repo,
				state: "open",
			},
			(response) => response.data,
		);
		pullRequestNumber = openPullRequests.find(
			(pullRequest) => pullRequest.head.sha === run.head_sha,
		)?.number;
	}
	if (pullRequestNumber == null) {
		console.log("No pull request found for the integrity result");
		return;
	}

	const { data: currentPullRequest } = await github.rest.pulls.get({
		...context.repo,
		pull_number: pullRequestNumber,
	});
	if (currentPullRequest.head.sha !== run.head_sha) {
		console.log("Skipping integrity result from a stale workflow run");
		return;
	}

	const jobs = await github.paginate(
		github.rest.actions.listJobsForWorkflowRun,
		{
			...context.repo,
			run_id: run.id,
		},
	);
	const integrityJob = jobs.find((job) => job.name === INTEGRITY_JOB_NAME);
	if (
		!integrityJob ||
		!["success", "failure"].includes(integrityJob.conclusion ?? "")
	) {
		return;
	}

	const comments = await github.paginate(
		github.rest.issues.listComments,
		{
			...context.repo,
			issue_number: pullRequestNumber,
		},
		(response) => response.data,
	);
	for (const comment of comments) {
		if (
			comment.body?.endsWith(COMMENT_TAG) &&
			comment.user?.login === "github-actions[bot]"
		) {
			await github.rest.issues.deleteComment({
				...context.repo,
				comment_id: comment.id,
			});
		}
	}

	if (integrityJob.conclusion === "failure") {
		await github.rest.issues.createComment({
			...context.repo,
			issue_number: pullRequestNumber,
			body: `### Firmware integrity check failed

See the [job logs](${integrityJob.html_url}) for details.
${COMMENT_TAG}`,
		});
	}
}
