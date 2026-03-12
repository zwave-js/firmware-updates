"use strict";

const SUBMISSION_PR_BRANCH_REGEX = /^firmware-submission\/issue-(\d+)$/;
const SUBMISSION_PR_MARKER = "<!-- firmware-submission-pr -->";
const SUBMISSION_PR_AUTHOR = "zwave-js-bot";

/**
 * Returns the linked issue number for a bot-managed firmware submission PR.
 * The branch living in the base repository is the trust anchor here.
 *
 * @param {any} pr
 * @param {string} owner
 * @param {string} repo
 * @returns {number | null}
 */
function getSubmissionIssueNumberFromPR(pr, owner, repo) {
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

	const issueNumber = parseInt(branchMatch[1], 10);
	if (!Number.isInteger(issueNumber)) {
		return null;
	}

	const body = pr.body ?? "";
	const closesMatch = body.match(/Closes #(\d+)/);
	if (closesMatch && parseInt(closesMatch[1], 10) !== issueNumber) {
		return null;
	}

	const generatedMatch = body.match(/Auto-generated from issue #(\d+)\./);
	if (generatedMatch && parseInt(generatedMatch[1], 10) !== issueNumber) {
		return null;
	}

	return issueNumber;
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function createSubmissionPRBody(issueNumber) {
	return `Closes #${issueNumber}\n\nAuto-generated from issue #${issueNumber}.\n\n${SUBMISSION_PR_MARKER}`;
}

module.exports = {
	SUBMISSION_PR_AUTHOR,
	SUBMISSION_PR_MARKER,
	createSubmissionPRBody,
	getSubmissionIssueNumberFromPR,
};
