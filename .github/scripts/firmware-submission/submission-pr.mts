import type { GitHubClient } from "../types.mts";

const SUBMISSION_PR_BRANCH_REGEX = /^firmware-submission\/issue-(\d+)$/;

export const SUBMISSION_PR_MARKER = "<!-- firmware-submission-pr -->";
export const SUBMISSION_COMMENT_TAG = "<!-- firmware-submission-status -->";
export const SUBMISSION_PR_AUTHOR = "zwave-js-bot";

/** Delete existing status comments posted by the bot on the given issue. */
export async function deleteExistingStatusComments(
	octokit: GitHubClient,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<void> {
	const comments = await octokit.paginate(octokit.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
	});

	const statusComments = comments.filter(
		(comment) =>
			comment.body?.endsWith(SUBMISSION_COMMENT_TAG) &&
			comment.user?.login === SUBMISSION_PR_AUTHOR,
	);

	console.log(
		`Found ${statusComments.length} status comment(s) to delete` +
			` (out of ${comments.length} total).`,
	);

	for (const comment of statusComments) {
		console.log(`Deleting status comment ${comment.id}...`);
		await octokit.rest.issues.deleteComment({
			owner,
			repo,
			comment_id: comment.id,
		});
	}
}

/** Delete previous status comments and post a fresh one, or none if `body` is null. */
export async function postStatusComment(
	octokit: GitHubClient,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string | null,
): Promise<void> {
	await deleteExistingStatusComments(octokit, owner, repo, issueNumber);
	if (body == null) return;

	await octokit.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body: `${body}\n${SUBMISSION_COMMENT_TAG}`,
	});
}

export interface SubmissionPRLike {
	head?: {
		repo?: {
			full_name?: string;
		} | null;
		ref?: string;
	};
	user?: {
		login?: string;
	} | null;
	body?: string | null;
}

export function getSubmissionIssueNumberFromPR(
	pr: SubmissionPRLike | undefined | null,
	owner: string,
	repo: string,
): number | null {
	if (pr?.head?.repo?.full_name !== `${owner}/${repo}`) {
		return null;
	}

	if (pr.user?.login !== SUBMISSION_PR_AUTHOR) {
		return null;
	}

	const branchMatch = pr.head.ref?.match(SUBMISSION_PR_BRANCH_REGEX);
	if (!branchMatch) {
		return null;
	}

	const issueNumber = Number.parseInt(branchMatch[1]!, 10);

	const body = pr.body ?? "";
	const closesMatch = body.match(/Closes #(\d+)/);
	if (closesMatch && Number.parseInt(closesMatch[1]!, 10) !== issueNumber) {
		return null;
	}

	const generatedMatch = body.match(/Auto-generated from issue #(\d+)\./)
		?? body.match(/<!-- Auto-generated from issue #(\d+)\. -->/);
	if (
		generatedMatch &&
		Number.parseInt(generatedMatch[1]!, 10) !== issueNumber
	) {
		return null;
	}

	return issueNumber;
}

export function createSubmissionPRBody(issueNumber: number): string {
	return `Closes #${issueNumber}\n\n<!-- Auto-generated from issue #${issueNumber}. -->\n${SUBMISSION_PR_MARKER}`;
}
