const SUBMISSION_PR_BRANCH_REGEX = /^firmware-submission\/issue-(\d+)$/;

export const SUBMISSION_PR_MARKER = "<!-- firmware-submission-pr -->";
export const SUBMISSION_COMMENT_TAG = "<!-- firmware-submission-status -->";
export const SUBMISSION_PR_AUTHOR = "zwave-js-bot";

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
