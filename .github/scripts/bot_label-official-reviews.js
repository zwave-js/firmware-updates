// @ts-check

/// <reference path="types.d.ts" />
const { manufacturerAccounts, officialLabel } = require("./definitions");

/**
 * @param {{github: Github, context: Context}} param
 */
async function main(param) {
	const { github, context } = param;

	const options = {
		owner: context.repo.owner,
		repo: context.repo.repo,
	};

	const issue_number = context.payload.pull_request?.number;
	if (!issue_number) {
		github.log.info("Not a pull request, skipping");
		return;
	}

	const review = context.payload.pull_request_review;
	const author = review?.user?.login;
	if (!author) {
		github.log.info("No review author found, skipping");
		return;
	}

	const isManufacturer = manufacturerAccounts.includes(author);
	if (!isManufacturer) {
		github.log.info(`Author ${author} is not a manufacturer, skipping`);
		return;
	}

	if (review.state === "APPROVED") {
		// Add label to PR
		github.log.info(
			`PR was approved by a manufacturer, adding official label`
		);
		await github.rest.issues.addLabels({
			...options,
			issue_number,
			labels: [officialLabel],
		});
	}
}
module.exports = main;
