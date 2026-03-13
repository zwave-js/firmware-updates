// @ts-check
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getOctokit } = require("@actions/github");
const prettier = require("prettier");
const JSON5 = require("json5");
const {
	downloadFirmware,
	generateHash,
} = require("@zwave-js/firmware-integrity");
const { createSubmissionPRBody } = require("./submission-pr.cjs");

const COMMENT_TAG = "<!-- firmware-submission-status -->";
const VALID_REGIONS = [
	"europe",
	"usa",
	"australia/new zealand",
	"hong kong",
	"india",
	"israel",
	"russia",
	"china",
	"japan",
	"korea",
];

const GITHUB_TOKEN = /** @type {string} */ (process.env.GITHUB_TOKEN);
const BOT_TOKEN = /** @type {string} */ (process.env.BOT_TOKEN);
const GITHUB_EVENT_PATH = /** @type {string} */ (process.env.GITHUB_EVENT_PATH);
const ISSUE_NUMBER = parseInt(
	/** @type {string} */ (process.env.ISSUE_NUMBER),
	10,
);
const REPO_OWNER = /** @type {string} */ (process.env.REPO_OWNER);
const REPO_NAME = /** @type {string} */ (process.env.REPO_NAME);

const octokit = getOctokit(GITHUB_TOKEN);
const botOctokit = getOctokit(BOT_TOKEN);

const workspaceRoot = path.resolve(__dirname, "../../..");
const firmwareRoot = path.join(workspaceRoot, "firmwares");

/**
 * @typedef {{
 *   brand: string,
 *   model: string,
 *   manufacturerId: string,
 *   productType: string,
 *   productId: string,
 *   firmwareVersion?: {
 *     min: string,
 *     max: string,
 *   },
 * }} SubmissionDevice
 */

/**
 * @typedef {{
 *   brand: string,
 *   model: string,
 *   manufacturerId: string,
 *   productType: string,
 *   productId: string,
 *   firmwareVersion: {
 *     min: string,
 *     max: string,
 *   },
 * }} NormalizedDevice
 */

/**
 * @typedef {{
 *   relativePath: string,
 *   absolutePath: string,
 *   directory: string,
 *   config: Record<string, any>,
 *   devices: NormalizedDevice[],
 * }} FirmwareConfigFile
 */

/**
 * @typedef {{
 *   issue?: {
 *     number?: number,
 *     body?: string | null,
 *   },
 * }} IssuesLabeledEventPayload
 */

class SubmissionValidationError extends Error {}

// ─── Git helper (avoids shell injection) ─────────────────────────────────────

/** @param {...string} args */
function git(...args) {
	const result = spawnSync("git", args, {
		cwd: workspaceRoot,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args[0]} failed:\n${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

/**
 * @param {string} brand
 * @returns {string}
 */
function formatBrandDirectory(brand) {
	return sanitizePathComponent(brand).toLowerCase().replace(/\s+/g, "-");
}

/**
 * @param {SubmissionDevice} device
 * @returns {NormalizedDevice}
 */
function normalizeDevice(device) {
	return {
		brand: device.brand,
		model: device.model,
		manufacturerId: device.manufacturerId,
		productType: device.productType,
		productId: device.productId,
		firmwareVersion: device.firmwareVersion ?? {
			min: "0.0",
			max: "255.255",
		},
	};
}

/**
 * @param {NormalizedDevice} left
 * @param {NormalizedDevice} right
 * @returns {boolean}
 */
function sameExactDevice(left, right) {
	return (
		left.manufacturerId === right.manufacturerId &&
		left.productType === right.productType &&
		left.productId === right.productId &&
		left.firmwareVersion.min === right.firmwareVersion.min &&
		left.firmwareVersion.max === right.firmwareVersion.max
	);
}

/**
 * @param {NormalizedDevice} left
 * @param {NormalizedDevice} right
 * @returns {boolean}
 */
function sameBaseDevice(left, right) {
	return (
		left.manufacturerId === right.manufacturerId &&
		left.productType === right.productType &&
		left.productId === right.productId
	);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFirmwareConfigFile(filePath) {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return (
		filePath.endsWith(".json") &&
		!filePath.endsWith("index.json") &&
		!path.basename(filePath).startsWith("_") &&
		!normalizedPath.includes("/templates/")
	);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFirmwareConfigPaths(dir) {
	/** @type {string[]} */
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...listFirmwareConfigPaths(fullPath));
		} else if (entry.isFile() && isFirmwareConfigFile(fullPath)) {
			results.push(fullPath);
		}
	}
	return results.sort((left, right) => left.localeCompare(right));
}

/**
 * @returns {FirmwareConfigFile[]}
 */
function loadFirmwareConfigs() {
	return listFirmwareConfigPaths(firmwareRoot).map((absolutePath) => {
		const config = JSON5.parse(fs.readFileSync(absolutePath, "utf-8"));
		if (!Array.isArray(config?.devices)) {
			throw new Error(
				`Firmware config ${absolutePath} does not contain a devices array.`,
			);
		}

		const relativeWithinFirmwares = path
			.relative(firmwareRoot, absolutePath)
			.replace(/\\/g, "/");

		return {
			relativePath: path.posix.join("firmwares", relativeWithinFirmwares),
			absolutePath,
			directory: path.posix.dirname(relativeWithinFirmwares),
			config,
			devices: config.devices.map((device) =>
				normalizeDevice(/** @type {SubmissionDevice} */ (device)),
			),
		};
	});
}

/**
 * @param {string[]} candidates
 * @param {string} preferredDirectory
 * @param {string} subject
 * @returns {string}
 */
function chooseExistingDirectory(candidates, preferredDirectory, subject) {
	if (candidates.length === 1) {
		return candidates[0];
	}
	if (candidates.includes(preferredDirectory)) {
		return preferredDirectory;
	}
	throw new SubmissionValidationError(
		`${subject} maps to multiple existing firmware directories (${candidates.join(", ")}). Please split the submission or open a PR directly.`,
	);
}

/**
 * @param {NormalizedDevice} device
 * @param {FirmwareConfigFile[]} firmwareConfigs
 * @returns {string | null}
 */
function findPreferredDirectoryForDevice(device, firmwareConfigs) {
	const preferredDirectory = formatBrandDirectory(device.brand);
	const baseMatchDirectories = [
		...new Set(
			firmwareConfigs
				.filter((file) =>
					file.devices.some((existingDevice) =>
						sameBaseDevice(existingDevice, device),
					),
				)
				.map((file) => file.directory),
		),
	];
	if (baseMatchDirectories.length > 0) {
		return chooseExistingDirectory(
			baseMatchDirectories,
			preferredDirectory,
			`Device ${device.brand} ${device.model}`,
		);
	}

	const manufacturerDirectories = [
		...new Set(
			firmwareConfigs
				.filter((file) =>
					file.devices.some(
						(existingDevice) =>
							existingDevice.manufacturerId ===
							device.manufacturerId,
					),
				)
				.map((file) => file.directory),
		),
	];
	if (manufacturerDirectories.length > 0) {
		return chooseExistingDirectory(
			manufacturerDirectories,
			preferredDirectory,
			`Manufacturer ${device.manufacturerId}`,
		);
	}

	return null;
}

/**
 * @param {NormalizedDevice[]} submittedDevices
 * @param {FirmwareConfigFile[]} firmwareConfigs
 * @returns {string}
 */
function determineNewFileDirectory(submittedDevices, firmwareConfigs) {
	const resolvedDirectories = [
		...new Set(
			submittedDevices
				.map((device) =>
					findPreferredDirectoryForDevice(device, firmwareConfigs),
				)
				.filter(Boolean),
		),
	];
	if (resolvedDirectories.length > 1) {
		throw new SubmissionValidationError(
			`The submitted devices map to multiple existing firmware directories (${resolvedDirectories.join(", ")}). Please split the submission or open a PR directly.`,
		);
	}
	if (resolvedDirectories.length === 1) {
		return resolvedDirectories[0];
	}
	return formatBrandDirectory(submittedDevices[0].brand);
}

// ─── Label helpers ────────────────────────────────────────────────────────────

/** @param {string} label */
async function addLabel(label) {
	await octokit.rest.issues.addLabels({
		owner: REPO_OWNER,
		repo: REPO_NAME,
		issue_number: ISSUE_NUMBER,
		labels: [label],
	});
}

/** @param {string} label */
async function removeLabel(label) {
	try {
		await octokit.rest.issues.removeLabel({
			owner: REPO_OWNER,
			repo: REPO_NAME,
			issue_number: ISSUE_NUMBER,
			name: label,
		});
	} catch {
		// Label may not be present; ignore 404
	}
}

// ─── Comment helpers ──────────────────────────────────────────────────────────

async function minimizeExistingStatusComment() {
	const comments = await botOctokit.paginate(
		botOctokit.rest.issues.listComments,
		{
			owner: REPO_OWNER,
			repo: REPO_NAME,
			issue_number: ISSUE_NUMBER,
		},
	);

	const existing = comments.find(
		(c) =>
			c.body?.endsWith(COMMENT_TAG) && c.user?.login === "zwave-js-bot",
	);

	if (existing) {
		try {
			await botOctokit.graphql(
				`
				mutation($id: ID!) {
					minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
						minimizedComment { isMinimized }
					}
				}
			`,
				{ id: existing.node_id },
			);
		} catch {
			// Non-fatal: best effort
		}
	}
}

/** @param {string} body */
async function postStatusComment(body) {
	await minimizeExistingStatusComment();
	await botOctokit.rest.issues.createComment({
		owner: REPO_OWNER,
		repo: REPO_NAME,
		issue_number: ISSUE_NUMBER,
		body: body + "\n" + COMMENT_TAG,
	});
}

// ─── Error handling ───────────────────────────────────────────────────────────

/** @param {string[]} errors */
async function failWithErrors(errors) {
	await removeLabel("processing");
	await addLabel("checks-failed");

	const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join("\n");

	await postStatusComment(
		`There were problems with your submission:\n\n${errorList}\n\nPlease edit the issue body to fix these issues, then ask a maintainer to re-trigger processing.`,
	);

	process.exit(1);
}

async function failBecauseIssueChangedAfterApproval() {
	await removeLabel("processing");
	await addLabel("checks-failed");

	await postStatusComment(
		"This submission was edited after it was approved, so processing was skipped. Please ask a maintainer to review the updated issue body and re-apply the `approved` label before processing again.",
	);

	process.exit(1);
}

function loadApprovedIssueSnapshot() {
	if (!GITHUB_EVENT_PATH) {
		throw new Error("GITHUB_EVENT_PATH is not set.");
	}

	/** @type {IssuesLabeledEventPayload} */
	let payload;
	try {
		payload = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, "utf-8"));
	} catch (error) {
		throw new Error(
			`Could not read workflow event payload: ${/** @type {Error} */ (error).message}`,
		);
	}

	if (payload?.issue?.number !== ISSUE_NUMBER) {
		throw new Error(
			"Workflow event payload does not match the submission issue.",
		);
	}

	return payload.issue;
}

// ─── Issue body parser ────────────────────────────────────────────────────────

/**
 * Parses a GitHub issue form body into a map of heading → value.
 * GitHub issue forms render as: ### Heading\n\nValue\n\n### Next Heading\n\n...
 * @param {string} body
 * @returns {Record<string, string | null>}
 */
function parseIssueBody(body) {
	/** @type {Record<string, string | null>} */
	const sections = {};
	// Split on lines that start a new ### heading
	const parts = body.split(/\r?\n(?=### )/);
	for (const part of parts) {
		// Each part: "### Heading\n\nContent" (or just "### Heading\n\n")
		const match = part.match(/^### (.+?)\r?\n\r?\n([\s\S]*)/);
		if (!match) continue;
		const heading = match[1].trim();
		const value = match[2].trim();
		sections[heading] =
			value === "_No response_" || value === "" ? null : value;
	}
	return sections;
}

/**
 * @param {Record<string, string | null>} sections
 * @param {string} label
 * @param {boolean} required
 * @param {string[]} errors
 */
function getField(sections, label, required, errors) {
	if (!(label in sections)) {
		if (required) {
			errors.push(
				`Could not find the '${label}' field. Has the issue body been edited manually?`,
			);
		}
		return null;
	}
	const value = sections[label];
	if (value == null) {
		if (required) {
			errors.push(`The '${label}' field is required but was left blank.`);
		}
		return null;
	}
	return value;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const hexRegex = /^0x[a-f0-9]{4}$/i;
const versionRegex = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;

/**
 * @param {string} value
 * @param {string} fieldName
 * @param {string[]} errors
 */
function validateHex(value, fieldName, errors) {
	if (!hexRegex.test(value)) {
		errors.push(
			`'${fieldName}' must be a 4-digit hex value (e.g. 0x001d), got: ${value}`,
		);
		return false;
	}
	return true;
}

/**
 * @param {string} value
 * @param {string} fieldName
 * @param {string[]} errors
 */
function validateName(value, fieldName, errors) {
	if (/\.\./.test(value) || value.includes("\\")) {
		errors.push(`'${fieldName}' contains invalid characters.`);
		return false;
	}
	return true;
}

/**
 * Sanitize a value for use in file/directory names.
 * @param {string} value
 */
function sanitizePathComponent(value) {
	return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

/**
 * @param {string} value
 * @param {string} fieldName
 * @param {string[]} errors
 */
function validateUrl(value, fieldName, errors) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		errors.push(`'${fieldName}' is not a valid URL: ${value}`);
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		errors.push(
			`'${fieldName}' must use HTTP or HTTPS, got: ${parsed.protocol}`,
		);
		return false;
	}
	return true;
}

/**
 * @param {string} value
 * @param {string} fieldName
 * @param {string[]} errors
 */
function validateVersion(value, fieldName, errors) {
	if (!versionRegex.test(value)) {
		errors.push(
			`'${fieldName}' must be a valid firmware version (e.g. 1.23), got: ${value}`,
		);
		return false;
	}
	const parts = value.split(".").map((p) => parseInt(p, 10));
	if (parts.some((n) => n < 0 || n > 255)) {
		errors.push(
			`'${fieldName}' version components must each be between 0 and 255, got: ${value}`,
		);
		return false;
	}
	return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const approvedIssue = loadApprovedIssueSnapshot();
	const approvedBody = approvedIssue.body ?? "";

	// Reject if the issue body changed after approval.
	const { data: issue } = await octokit.rest.issues.get({
		owner: REPO_OWNER,
		repo: REPO_NAME,
		issue_number: ISSUE_NUMBER,
	});
	if ((issue.body ?? "") !== approvedBody) {
		await failBecauseIssueChangedAfterApproval();
		return;
	}

	// A. Mark as processing once the approved snapshot is validated.
	await addLabel("processing");

	// B. Parse the issue body captured by the approval event.
	const sections = parseIssueBody(approvedBody);

	const errors = [];

	// ── C/D. Parse and validate devices ───────────────────────────────────────

	/** @param {string} name @param {number} index */
	function deviceLabel(name, index) {
		return index === 1 ? name : `${name} (Device ${index})`;
	}

	/** @param {(string | null)[]} values */
	function hasAnyValue(values) {
		return values.some((value) => value != null);
	}

	/** @param {number} index */
	function parseDevice(index) {
		const started =
			index === 1 ||
			hasAnyValue([
				getField(sections, deviceLabel("Brand", index), false, errors),
				getField(sections, deviceLabel("Model", index), false, errors),
				getField(
					sections,
					deviceLabel("Manufacturer ID", index),
					false,
					errors,
				),
				getField(
					sections,
					deviceLabel("Product Type", index),
					false,
					errors,
				),
				getField(
					sections,
					deviceLabel("Product ID", index),
					false,
					errors,
				),
				getField(
					sections,
					deviceLabel("Firmware Version (Min)", index),
					false,
					errors,
				),
				getField(
					sections,
					deviceLabel("Firmware Version (Max)", index),
					false,
					errors,
				),
			]);

		if (!started) return null;

		const brand = getField(
			sections,
			deviceLabel("Brand", index),
			true,
			errors,
		);
		const model = getField(
			sections,
			deviceLabel("Model", index),
			true,
			errors,
		);
		const manufacturerId = getField(
			sections,
			deviceLabel("Manufacturer ID", index),
			true,
			errors,
		);
		const productType = getField(
			sections,
			deviceLabel("Product Type", index),
			true,
			errors,
		);
		const productId = getField(
			sections,
			deviceLabel("Product ID", index),
			true,
			errors,
		);
		const firmwareVersionMin = getField(
			sections,
			deviceLabel("Firmware Version (Min)", index),
			false,
			errors,
		);
		const firmwareVersionMax = getField(
			sections,
			deviceLabel("Firmware Version (Max)", index),
			false,
			errors,
		);

		if (brand) validateName(brand, deviceLabel("Brand", index), errors);
		if (model) validateName(model, deviceLabel("Model", index), errors);
		if (manufacturerId)
			validateHex(
				manufacturerId,
				deviceLabel("Manufacturer ID", index),
				errors,
			);
		if (productType)
			validateHex(
				productType,
				deviceLabel("Product Type", index),
				errors,
			);
		if (productId)
			validateHex(productId, deviceLabel("Product ID", index), errors);
		if (firmwareVersionMin)
			validateVersion(
				firmwareVersionMin,
				deviceLabel("Firmware Version (Min)", index),
				errors,
			);
		if (firmwareVersionMax)
			validateVersion(
				firmwareVersionMax,
				deviceLabel("Firmware Version (Max)", index),
				errors,
			);

		/** @type {Record<string, any>} */
		const device = { brand, model, manufacturerId, productType, productId };
		if (firmwareVersionMin || firmwareVersionMax) {
			device.firmwareVersion = {
				min: firmwareVersionMin ?? "0.0",
				max: firmwareVersionMax ?? "255.255",
			};
		}
		return device;
	}

	const devices =
		/** @type {NonNullable<ReturnType<typeof parseDevice>>[]} */ (
			[parseDevice(1), parseDevice(2), parseDevice(3)].filter(Boolean)
		);

	// ── Parse and validate upgrades ────────────────────────────────────────────

	/** @param {string} name @param {number} index */
	function upgradeLabel(name, index) {
		return index === 1 ? name : `${name} (Upgrade ${index})`;
	}

	/** @param {number} targetIndex @param {number} upgradeIndex */
	function urlLabel(targetIndex, upgradeIndex) {
		if (upgradeIndex === 1) return `Firmware URL (Target ${targetIndex})`;
		return `Firmware URL (Target ${targetIndex}) (Upgrade ${upgradeIndex})`;
	}

	const upgradeFormData = [];
	for (let i = 1; i <= 4; i++) {
		const started =
			i === 1 ||
			hasAnyValue([
				getField(
					sections,
					upgradeLabel("Firmware Version", i),
					false,
					errors,
				),
				getField(sections, upgradeLabel("Changelog", i), false, errors),
				getField(sections, upgradeLabel("Channel", i), false, errors),
				getField(sections, upgradeLabel("Region", i), false, errors),
				getField(
					sections,
					upgradeLabel("Upgrade conditions", i),
					false,
					errors,
				),
				getField(sections, urlLabel(0, i), false, errors),
				getField(sections, urlLabel(1, i), false, errors),
				getField(sections, urlLabel(2, i), false, errors),
			]);

		if (!started) continue;

		const version = getField(
			sections,
			upgradeLabel("Firmware Version", i),
			true,
			errors,
		);
		const changelog = getField(
			sections,
			upgradeLabel("Changelog", i),
			true,
			errors,
		);
		const channelRaw = getField(
			sections,
			upgradeLabel("Channel", i),
			true,
			errors,
		);
		const regionRaw = getField(
			sections,
			upgradeLabel("Region", i),
			false,
			errors,
		);
		const ifCondition = getField(
			sections,
			upgradeLabel("Upgrade conditions", i),
			false,
			errors,
		);
		const urlTarget0 = getField(sections, urlLabel(0, i), true, errors);
		const urlTarget1 = getField(sections, urlLabel(1, i), false, errors);
		const urlTarget2 = getField(sections, urlLabel(2, i), false, errors);

		let channel = null;
		let region = null;

		if (version)
			validateVersion(
				version,
				upgradeLabel("Firmware Version", i),
				errors,
			);

		if (urlTarget0) validateUrl(urlTarget0, urlLabel(0, i), errors);
		if (urlTarget1) validateUrl(urlTarget1, urlLabel(1, i), errors);
		if (urlTarget2) validateUrl(urlTarget2, urlLabel(2, i), errors);

		if (channelRaw) {
			if (["stable", "beta"].includes(channelRaw)) {
				channel = channelRaw;
			} else {
				errors.push(
					`'${upgradeLabel("Channel", i)}' must be 'stable' or 'beta', got: ${channelRaw}`,
				);
			}
		}

		if (regionRaw && regionRaw !== "All regions") {
			if (VALID_REGIONS.includes(regionRaw)) {
				region = regionRaw;
			} else {
				errors.push(
					`'${upgradeLabel("Region", i)}' is not a valid region: ${regionRaw}`,
				);
			}
		}

		upgradeFormData.push({
			index: i,
			version,
			changelog,
			channel,
			region,
			ifCondition,
			urlTarget0,
			urlTarget1,
			urlTarget2,
		});
	}

	const activeUpgrades = upgradeFormData;

	// ── Exit early if validation errors ───────────────────────────────────────
	if (errors.length > 0) {
		await failWithErrors(errors);
		return;
	}

	const branchName = `firmware-submission/issue-${ISSUE_NUMBER}`;

	// Configure git identity
	git("config", "user.name", "zwave-js-bot");
	git("config", "user.email", "zwave-js-bot@users.noreply.github.com");

	// Always resolve against the latest main branch, then rebuild the
	// submission branch from there so resubmissions replace the PR with one commit.
	git("fetch", "origin", "main");
	git("checkout", "-B", branchName, "origin/main");

	const brand = devices[0].brand;
	const model = devices[0].model;
	const safeModel = sanitizePathComponent(model);
	const firmwareVersionMin = devices[0].firmwareVersion?.min;
	const firmwareVersionMax = devices[0].firmwareVersion?.max;
	const versionRangeSuffix =
		firmwareVersionMin || firmwareVersionMax
			? `_${firmwareVersionMin ?? "0.0"}-${firmwareVersionMax ?? "255.255"}`
			: "";
	const fileName = `${safeModel}${versionRangeSuffix}.json`;
	const submittedDevices = devices.map((device) => normalizeDevice(device));

	/** @type {FirmwareConfigFile | null} */
	let matchedExistingFile = null;
	/** @type {string} */
	let relativeFilePath;
	/** @type {string} */
	let absoluteFilePath;

	try {
		const firmwareConfigs = loadFirmwareConfigs();
		// Collect exact file matches for each submitted device.
		const exactMatches = submittedDevices.map((device) =>
			firmwareConfigs.filter((file) =>
				file.devices.some((existingDevice) =>
					sameExactDevice(existingDevice, device),
				),
			),
		);

		const matchedExistingFiles = [...new Set(exactMatches.flat())];
		// One submission must resolve to exactly one existing file.
		if (matchedExistingFiles.length > 1) {
			throw new SubmissionValidationError(
				`This submission matches devices in multiple existing firmware files (${matchedExistingFiles.map((file) => file.relativePath).join(", ")}). We cannot determine which file to update. Please split the submission or open a PR directly.`,
			);
		}

		if (matchedExistingFiles.length === 1) {
			matchedExistingFile = matchedExistingFiles[0];
			// Reject partial overlap instead of expanding an existing file's device list.
			const matchingDeviceCount = submittedDevices.filter((device) =>
				matchedExistingFile.devices.some((existingDevice) =>
					sameExactDevice(existingDevice, device),
				),
			).length;
			if (matchingDeviceCount !== submittedDevices.length) {
				throw new SubmissionValidationError(
					`This multi-device submission only partially matches the devices in ${matchedExistingFile.relativePath}. Adding the remaining device identifiers to that file could introduce unwanted upgrade paths. Please split the submission or open a PR directly.`,
				);
			}

			relativeFilePath = matchedExistingFile.relativePath;
			absoluteFilePath = matchedExistingFile.absolutePath;
		} else {
			// No exact match: create one new file in the best matching directory.
			const brandDir = determineNewFileDirectory(
				submittedDevices,
				firmwareConfigs,
			);
			relativeFilePath = path.posix.join("firmwares", brandDir, fileName);
			absoluteFilePath = path.join(workspaceRoot, relativeFilePath);

			if (fs.existsSync(absoluteFilePath)) {
				throw new SubmissionValidationError(
					`A firmware config already exists at ${relativeFilePath}, but it does not match the submitted device identifiers. Please open a PR directly.`,
				);
			}
		}
	} catch (error) {
		if (error instanceof SubmissionValidationError) {
			await failWithErrors([error.message]);
			return;
		}
		throw error;
	}

	/** @type {Record<string, any> | null} */
	const existingConfig = matchedExistingFile?.config ?? null;

	// ── E. Download firmware and compute integrity hashes ──────────────────────

	/** @type {Array<Array<{url: string, integrity: string}>>} */
	const upgradeHashes = [];
	for (const upgrade of activeUpgrades) {
		const urls = /** @type {string[]} */ (
			[upgrade.urlTarget0, upgrade.urlTarget1, upgrade.urlTarget2].filter(
				Boolean,
			)
		);
		/** @type {{ url: string, integrity: string }[]} */
		const hashes = [];

		for (const url of urls) {
			let filename, rawData;
			try {
				({ filename, rawData } = await downloadFirmware(url));
			} catch (e) {
				await failWithErrors([
					`Failed to download firmware from ${url}: ${e.message}`,
				]);
				return;
			}

			let integrity;
			try {
				integrity = generateHash(filename, rawData);
			} catch (e) {
				await failWithErrors([
					`Failed to compute integrity hash for ${url}: ${e.message}`,
				]);
				return;
			}

			hashes.push({ url, integrity });
		}

		upgradeHashes.push(hashes);
	}

	// ── F. Format changelogs with prettier ────────────────────────────────────

	const prettierConfig = (await prettier.resolveConfig(workspaceRoot)) ?? {};

	const formattedChangelogs = [];
	for (const upgrade of activeUpgrades) {
		if (!upgrade.changelog) {
			formattedChangelogs.push("");
			continue;
		}
		const raw = upgrade.changelog.trim().replace(/\r\n/g, "\n");
		let formatted;
		try {
			formatted = await prettier.format(raw, {
				...prettierConfig,
				parser: "markdown",
			});
		} catch {
			formatted = raw;
		}
		formattedChangelogs.push(formatted.trim());
	}

	// ── G. Build config object ────────────────────────────────────────────────

	const newUpgrades = activeUpgrades.map((upgrade, idx) => {
		const hashes = upgradeHashes[idx];
		const changelog = formattedChangelogs[idx];
		const hasMultipleTargets =
			upgrade.urlTarget1 != null || upgrade.urlTarget2 != null;

		/** @type {Record<string, any>} */
		const entry = {};
		if (upgrade.ifCondition) entry.$if = upgrade.ifCondition;
		entry.version = upgrade.version;
		entry.changelog = changelog;
		if (upgrade.channel && upgrade.channel !== "stable") {
			entry.channel = upgrade.channel;
		}
		if (upgrade.region) entry.region = upgrade.region;

		if (hasMultipleTargets) {
			entry.files = hashes.map(({ url, integrity }, targetIdx) => ({
				target: targetIdx,
				url,
				integrity,
			}));
		} else {
			entry.url = hashes[0].url;
			entry.integrity = hashes[0].integrity;
		}

		return entry;
	});

	if (existingConfig) {
		const existingVersions = new Set(
			(existingConfig.upgrades ?? [])
				.map((upgrade) =>
					typeof upgrade?.version === "string"
						? upgrade.version
						: null,
				)
				.filter(Boolean),
		);
		const duplicates = newUpgrades
			.filter((upgrade) => existingVersions.has(upgrade.version))
			.map((upgrade) => upgrade.version);
		if (duplicates.length > 0) {
			await failWithErrors([
				`Version(s) ${duplicates.join(", ")} already exist in ${relativeFilePath}. To update an existing entry, please submit a PR directly.`,
			]);
			return;
		}
	}

	const config = existingConfig
		? {
				...existingConfig,
				upgrades: [...(existingConfig.upgrades ?? []), ...newUpgrades],
			}
		: {
				devices: devices.map((device) => {
					/** @type {Record<string, any>} */
					const entry = {
						brand: device.brand,
						model: device.model,
						manufacturerId: device.manufacturerId,
						productType: device.productType,
						productId: device.productId,
					};
					if (device.firmwareVersion) {
						entry.firmwareVersion = device.firmwareVersion;
					}
					return entry;
				}),
				upgrades: newUpgrades,
			};

	// ── H. Write file, commit, and push ───────────────────────────────────────

	fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
	fs.writeFileSync(
		absoluteFilePath,
		JSON.stringify(config, null, "\t") + "\n",
		"utf-8",
	);

	git("add", relativeFilePath);
	const lastVersion = activeUpgrades[activeUpgrades.length - 1].version;
	const commitMessage = `Add ${brand} ${model} firmware v${lastVersion} (#${ISSUE_NUMBER})`;
	git("commit", "-m", commitMessage);

	git("push", "--force", "origin", branchName);

	// Check if PR already exists for this branch
	const { data: existingPRs } = await botOctokit.rest.pulls.list({
		owner: REPO_OWNER,
		repo: REPO_NAME,
		head: `${REPO_OWNER}:${branchName}`,
		state: "open",
	});

	let prUrl;
	if (existingPRs.length > 0) {
		prUrl = existingPRs[0].html_url;
	} else {
		const prTitle = `Add ${brand} ${model} firmware v${lastVersion}`;
		const { data: newPR } = await botOctokit.rest.pulls.create({
			owner: REPO_OWNER,
			repo: REPO_NAME,
			title: prTitle,
			head: branchName,
			base: "main",
			body: createSubmissionPRBody(ISSUE_NUMBER),
		});
		prUrl = newPR.html_url;
	}

	// ── I. Post success comment ────────────────────────────────────────────────

	await postStatusComment(
		`Your submission has been processed and a [pull request](${prUrl}) has been created. I'll post the CI check results here once they complete.`,
	);

	// Leave 'processing' label for the mirror workflow to clear
}

main().catch(async (err) => {
	console.error(err);
	try {
		await removeLabel("processing");
		await addLabel("checks-failed");
		await postStatusComment(
			`An unexpected error occurred while processing your submission:\n\n\`\`\`\n${err.message}\n\`\`\`\n\nPlease ask a maintainer to investigate.`,
		);
	} catch {
		// Ignore secondary errors
	}
	process.exit(1);
});
