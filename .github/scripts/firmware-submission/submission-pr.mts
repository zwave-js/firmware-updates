import type { GitHubClient } from "../types.mts";

const SUBMISSION_PR_BRANCH_REGEX = /^firmware-submission\/issue-(\d+)$/;

export const SUBMISSION_PR_MARKER = "<!-- firmware-submission-pr -->";
export const SUBMISSION_COMMENT_TAG = "<!-- firmware-submission-status -->";
export const SUBMISSION_PR_AUTHOR = "zwave-js-bot";

/** Replace existing bot status comments with one updated comment. */
export async function replaceExistingStatusComments(
	octokit: GitHubClient,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<boolean> {
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
		`Found ${statusComments.length} status comment(s) to replace` +
			` (out of ${comments.length} total).`,
	);

	if (statusComments.length === 0) {
		return false;
	}

	const [newestStatusComment, ...duplicateStatusComments] =
		statusComments.toSorted(
			(a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
		);
	const taggedBody = `${body}\n${SUBMISSION_COMMENT_TAG}`;

	console.log(`Updating status comment ${newestStatusComment!.id}...`);
	await octokit.rest.issues.updateComment({
		owner,
		repo,
		comment_id: newestStatusComment!.id,
		body: taggedBody,
	});

	for (const comment of duplicateStatusComments) {
		console.log(`Deleting duplicate status comment ${comment.id}...`);
		await octokit.rest.issues.deleteComment({
			owner,
			repo,
			comment_id: comment.id,
		});
	}

	return true;
}

/** Replace the existing status comment or create one when none exists. */
export async function postStatusComment(
	octokit: GitHubClient,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<void> {
	const replaced = await replaceExistingStatusComments(
		octokit,
		owner,
		repo,
		issueNumber,
		body,
	);
	if (replaced) return;

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
