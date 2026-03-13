import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as githubActions from "@actions/github";
import { downloadFirmware, generateHash } from "@zwave-js/firmware-integrity";
import JSON5 from "json5";
import prettier from "prettier";
import type { GitHubScriptContext } from "../types.mts";
import {
	SUBMISSION_COMMENT_TAG,
	createSubmissionPRBody,
} from "./submission-pr.mts";

const { getOctokit } = githubActions;

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
] as const;

const workspaceRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const firmwareRoot = path.join(workspaceRoot, "firmwares");

interface FirmwareVersionRange {
	min: string;
	max: string;
}

interface SubmissionDevice {
	brand: string;
	model: string;
	manufacturerId: string;
	productType: string;
	productId: string;
	firmwareVersion?: FirmwareVersionRange;
}

interface NormalizedDevice extends SubmissionDevice {
	firmwareVersion: FirmwareVersionRange;
}

interface FirmwareConfigFile {
	relativePath: string;
	absolutePath: string;
	directory: string;
	config: Record<string, any>;
	devices: NormalizedDevice[];
}

interface IssuesLabeledEventPayload {
	issue?: {
		number?: number;
		body?: string | null;
	};
}

interface UpgradeFormData {
	index: number;
	version: string;
	changelog: string;
	channel: "stable" | "beta" | null;
	region: string | null;
	ifCondition: string | null;
	urlTarget0: string;
	urlTarget1: string | null;
	urlTarget2: string | null;
}

interface FirmwareHash {
	url: string;
	integrity: string;
}

class SubmissionValidationError extends Error {}

class SubmissionHandledError extends Error {}

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set.`);
	}
	return value;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function git(...args: string[]): string {
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

function formatBrandDirectory(brand: string): string {
	return sanitizePathComponent(brand).toLowerCase().replace(/\s+/g, "-");
}

function normalizeDevice(device: SubmissionDevice): NormalizedDevice {
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

function sameExactDevice(
	left: NormalizedDevice,
	right: NormalizedDevice,
): boolean {
	return (
		left.manufacturerId === right.manufacturerId &&
		left.productType === right.productType &&
		left.productId === right.productId &&
		left.firmwareVersion.min === right.firmwareVersion.min &&
		left.firmwareVersion.max === right.firmwareVersion.max
	);
}

function sameBaseDevice(left: NormalizedDevice, right: NormalizedDevice): boolean {
	return (
		left.manufacturerId === right.manufacturerId &&
		left.productType === right.productType &&
		left.productId === right.productId
	);
}

function isFirmwareConfigFile(filePath: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return (
		filePath.endsWith(".json") &&
		!filePath.endsWith("index.json") &&
		!path.basename(filePath).startsWith("_") &&
		!normalizedPath.includes("/templates/")
	);
}

function listFirmwareConfigPaths(dir: string): string[] {
	const results: string[] = [];
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

function loadFirmwareConfigs(): FirmwareConfigFile[] {
	return listFirmwareConfigPaths(firmwareRoot).map((absolutePath) => {
		const config = JSON5.parse(
			fs.readFileSync(absolutePath, "utf-8"),
		) as Record<string, any>;
		if (!Array.isArray(config.devices)) {
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
			devices: config.devices.map((device: SubmissionDevice) =>
				normalizeDevice(device),
			),
		};
	});
}

function chooseExistingDirectory(
	candidates: string[],
	preferredDirectory: string,
	brand: string,
	firmwareConfigs: FirmwareConfigFile[],
	subject: string,
): string | null {
	if (candidates.length === 1) {
		return candidates[0]!;
	}
	if (candidates.includes(preferredDirectory)) {
		return preferredDirectory;
	}
	// The submitted brand name may not produce the same directory slug as
	// the existing directory (e.g. "Enbrighten GE" → "enbrighten_ge" vs
	// existing "enbrighten-ge"). Fall back to checking whether the brand
	// in the existing config files matches the submitted brand.
	const brandMatches = candidates.filter((dir) =>
		firmwareConfigs
			.filter((file) => file.directory === dir)
			.some((file) =>
				file.devices.some(
					(d) => d.brand.toLowerCase() === brand.toLowerCase(),
				),
			),
	);
	if (brandMatches.length === 1) {
		return brandMatches[0]!;
	}
	if (brandMatches.length === 0) {
		// No existing directory has files with this brand — treat as a new brand.
		return null;
	}
	throw new SubmissionValidationError(
		`${subject} maps to multiple existing firmware directories (${candidates.join(", ")}). Please split the submission or open a PR directly.`,
	);
}

function findPreferredDirectoryForDevice(
	device: NormalizedDevice,
	firmwareConfigs: FirmwareConfigFile[],
): string | null {
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
		const dir = chooseExistingDirectory(
			baseMatchDirectories,
			preferredDirectory,
			device.brand,
			firmwareConfigs,
			`Device ${device.brand} ${device.model}`,
		);
		if (dir != null) return dir;
	}

	const manufacturerDirectories = [
		...new Set(
			firmwareConfigs
				.filter((file) =>
					file.devices.some(
						(existingDevice) =>
							existingDevice.manufacturerId === device.manufacturerId,
					),
				)
				.map((file) => file.directory),
		),
	];
	if (manufacturerDirectories.length > 0) {
		const dir = chooseExistingDirectory(
			manufacturerDirectories,
			preferredDirectory,
			device.brand,
			firmwareConfigs,
			`Manufacturer ${device.manufacturerId}`,
		);
		if (dir != null) return dir;
	}

	return null;
}

function determineNewFileDirectory(
	submittedDevices: NormalizedDevice[],
	firmwareConfigs: FirmwareConfigFile[],
): string {
	const resolvedDirectories = [
		...new Set(
			submittedDevices
				.map((device) => findPreferredDirectoryForDevice(device, firmwareConfigs))
				.filter((directory): directory is string => directory != null),
		),
	];
	if (resolvedDirectories.length > 1) {
		throw new SubmissionValidationError(
			`The submitted devices map to multiple existing firmware directories (${resolvedDirectories.join(", ")}). Please split the submission or open a PR directly.`,
		);
	}
	if (resolvedDirectories.length === 1) {
		return resolvedDirectories[0]!;
	}
	return formatBrandDirectory(submittedDevices[0]!.brand);
}

function loadApprovedIssueSnapshot(
	issueNumber: number,
): IssuesLabeledEventPayload["issue"] {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new Error("GITHUB_EVENT_PATH is not set.");
	}

	let payload: IssuesLabeledEventPayload;
	try {
		payload = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
	} catch (error) {
		throw new Error(
			`Could not read workflow event payload: ${getErrorMessage(error)}`,
		);
	}

	if (payload.issue?.number !== issueNumber) {
		throw new Error("Workflow event payload does not match the submission issue.");
	}

	return payload.issue;
}

function parseIssueBody(body: string): Record<string, string | null> {
	const sections: Record<string, string | null> = {};
	const parts = body.split(/\r?\n(?=### )/);
	for (const part of parts) {
		const match = part.match(/^### (.+?)\r?\n\r?\n([\s\S]*)/);
		if (!match) continue;
		const heading = match[1]?.trim();
		if (!heading) continue;
		const value = (match[2] ?? "").trim();
		sections[heading] =
			value === "_No response_" || value === "" ? null : value;
	}
	return sections;
}

function getField(
	sections: Record<string, string | null>,
	label: string,
	required: boolean,
	errors: string[],
): string | null {
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

const hexRegex = /^0x[a-f0-9]{4}$/i;
const versionRegex = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;

function validateHex(value: string, fieldName: string, errors: string[]): boolean {
	if (!hexRegex.test(value)) {
		errors.push(
			`'${fieldName}' must be a 4-digit hex value (e.g. 0x001d), got: ${value}`,
		);
		return false;
	}
	return true;
}

function validateName(value: string, fieldName: string, errors: string[]): boolean {
	if (/\.\./.test(value) || value.includes("\\")) {
		errors.push(`'${fieldName}' contains invalid characters.`);
		return false;
	}
	return true;
}

function sanitizePathComponent(value: string): string {
	return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function validateUrl(value: string, fieldName: string, errors: string[]): boolean {
	let parsed: URL;
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

function validateVersion(
	value: string,
	fieldName: string,
	errors: string[],
): boolean {
	if (!versionRegex.test(value)) {
		errors.push(
			`'${fieldName}' must be a valid firmware version (e.g. 1.23), got: ${value}`,
		);
		return false;
	}
	const parts = value.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.some((part) => part < 0 || part > 255)) {
		errors.push(
			`'${fieldName}' version components must each be between 0 and 255, got: ${value}`,
		);
		return false;
	}
	return true;
}

export default async function main({
	github,
	context,
}: GitHubScriptContext): Promise<void> {
	const issueNumber = context.payload.issue?.number;
	if (issueNumber == null) {
		throw new Error("Workflow event payload does not contain an issue number.");
	}

	const owner = context.repo.owner;
	const repo = context.repo.repo;
	const botOctokit = getOctokit(getRequiredEnv("BOT_TOKEN"));

	const addLabel = async (label: string): Promise<void> => {
		await github.rest.issues.addLabels({
			owner,
			repo,
			issue_number: issueNumber,
			labels: [label],
		});
	};

	const removeLabel = async (label: string): Promise<void> => {
		try {
			await github.rest.issues.removeLabel({
				owner,
				repo,
				issue_number: issueNumber,
				name: label,
			});
		} catch {
			// Label may not be present.
		}
	};

	const minimizeExistingStatusComments = async (): Promise<void> => {
		const comments = await botOctokit.paginate(botOctokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: issueNumber,
		});

		const statusComments = comments.filter(
			(comment) =>
				comment.body?.endsWith(SUBMISSION_COMMENT_TAG) &&
				comment.user?.login === "zwave-js-bot",
		);

		for (const comment of statusComments) {
			try {
				await botOctokit.graphql(
					`
					mutation($id: ID!) {
						minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
							minimizedComment { isMinimized }
						}
					}
				`,
					{ id: comment.node_id },
				);
			} catch {
				// Best effort only.
			}
		}
	};

	const postStatusComment = async (body: string): Promise<void> => {
		await minimizeExistingStatusComments();
		await botOctokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body: `${body}\n${SUBMISSION_COMMENT_TAG}`,
		});
	};

	const failWithErrors = async (errors: string[]): Promise<never> => {
		await removeLabel("processing");
		await addLabel("checks-failed");

		const errorList = errors.map((error, index) => `${index + 1}. ${error}`).join("\n");
		await postStatusComment(
			`There were problems with your submission:\n\n${errorList}\n\nPlease edit the issue body to fix these issues, then ask a maintainer to re-trigger processing.`,
		);

		throw new SubmissionHandledError(errors.join("; "));
	};

	const failBecauseIssueChangedAfterApproval = async (): Promise<never> => {
		await removeLabel("processing");
		await addLabel("checks-failed");
		await postStatusComment(
			"This submission was edited after it was approved, so processing was skipped. Please ask a maintainer to review the updated issue body and re-apply the `approved` label before processing again.",
		);
		throw new SubmissionHandledError(
			"Submission was edited after it was approved.",
		);
	};

	try {
		console.log(`Processing firmware submission issue #${issueNumber}`);

		const approvedIssue = loadApprovedIssueSnapshot(issueNumber);
		const approvedBody = approvedIssue?.body ?? "";

		console.log("Checking if issue body was modified after approval...");
		const { data: issue } = await github.rest.issues.get({
			owner,
			repo,
			issue_number: issueNumber,
		});
		if ((issue.body ?? "") !== approvedBody) {
			await failBecauseIssueChangedAfterApproval();
		}

		// Reset to a consistent label state before processing.
		await removeLabel("submitted");
		await removeLabel("checks-failed");
		await addLabel("processing");
		console.log("Parsing issue body...");
		const sections = parseIssueBody(approvedBody);
		const errors: string[] = [];

		const deviceLabel = (name: string, index: number): string =>
			index === 1 ? name : `${name} (Device ${index})`;

		const hasAnyValue = (values: Array<string | null>): boolean =>
			values.some((value) => value != null);

		const parseDevice = (index: number): SubmissionDevice | null => {
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
					getField(sections, deviceLabel("Product Type", index), false, errors),
					getField(sections, deviceLabel("Product ID", index), false, errors),
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

			if (!started) {
				return null;
			}

			const brand = getField(sections, deviceLabel("Brand", index), true, errors);
			const model = getField(sections, deviceLabel("Model", index), true, errors);
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
			if (manufacturerId) {
				validateHex(
					manufacturerId,
					deviceLabel("Manufacturer ID", index),
					errors,
				);
			}
			if (productType) {
				validateHex(productType, deviceLabel("Product Type", index), errors);
			}
			if (productId) {
				validateHex(productId, deviceLabel("Product ID", index), errors);
			}
			if (firmwareVersionMin) {
				validateVersion(
					firmwareVersionMin,
					deviceLabel("Firmware Version (Min)", index),
					errors,
				);
			}
			if (firmwareVersionMax) {
				validateVersion(
					firmwareVersionMax,
					deviceLabel("Firmware Version (Max)", index),
					errors,
				);
			}

			if (!(brand && model && manufacturerId && productType && productId)) {
				return null;
			}

			const device: SubmissionDevice = {
				brand,
				model,
				manufacturerId: manufacturerId.toLowerCase(),
				productType: productType.toLowerCase(),
				productId: productId.toLowerCase(),
			};
			if (firmwareVersionMin || firmwareVersionMax) {
				device.firmwareVersion = {
					min: firmwareVersionMin ?? "0.0",
					max: firmwareVersionMax ?? "255.255",
				};
			}
			return device;
		};

		const devices = [parseDevice(1), parseDevice(2), parseDevice(3)].filter(
			(device): device is SubmissionDevice => device != null,
		);
		console.log(`Parsed ${devices.length} device(s):`,
			devices.map((d) => `${d.brand} ${d.model} (${d.manufacturerId}/${d.productType}/${d.productId})`).join(", "),
		);

		const upgradeLabel = (name: string, index: number): string =>
			index === 1 ? name : `${name} (Upgrade ${index})`;

		const urlLabel = (targetIndex: number, upgradeIndex: number): string => {
			if (upgradeIndex === 1) {
				return `Firmware URL (Target ${targetIndex})`;
			}
			return `Firmware URL (Target ${targetIndex}) (Upgrade ${upgradeIndex})`;
		};

		const upgradeFormData: UpgradeFormData[] = [];
		for (let i = 1; i <= 4; i++) {
			// Only check free text fields to determine if an upgrade was started.
			// Dropdown fields (Channel, Region) always have a default value in
			// GitHub issue forms, so they must not be used for this check.
			const started =
				i === 1 ||
				hasAnyValue([
					getField(sections, upgradeLabel("Firmware Version", i), false, errors),
					getField(sections, upgradeLabel("Changelog", i), false, errors),
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

			if (!started) {
				continue;
			}

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

			let channel: "stable" | "beta" | null = null;
			let region: string | null = null;

			if (version) {
				validateVersion(version, upgradeLabel("Firmware Version", i), errors);
			}
			if (urlTarget0) {
				validateUrl(urlTarget0, urlLabel(0, i), errors);
			}
			if (urlTarget1) {
				validateUrl(urlTarget1, urlLabel(1, i), errors);
			}
			if (urlTarget2) {
				validateUrl(urlTarget2, urlLabel(2, i), errors);
			}

			if (channelRaw) {
				if (channelRaw === "stable" || channelRaw === "beta") {
					channel = channelRaw;
				} else {
					errors.push(
						`'${upgradeLabel("Channel", i)}' must be 'stable' or 'beta', got: ${channelRaw}`,
					);
				}
			}

			if (regionRaw && regionRaw !== "All regions") {
				if (VALID_REGIONS.includes(regionRaw as (typeof VALID_REGIONS)[number])) {
					region = regionRaw;
				} else {
					errors.push(
						`'${upgradeLabel("Region", i)}' is not a valid region: ${regionRaw}`,
					);
				}
			}

			if (!(version && changelog && channelRaw && urlTarget0)) {
				continue;
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

		console.log(`Parsed ${upgradeFormData.length} upgrade(s):`,
			upgradeFormData.map((u) => `v${u.version} (${u.channel ?? "stable"})`).join(", "),
		);

		if (devices.length === 0) {
			errors.push("At least one device must be provided.");
		}
		if (upgradeFormData.length === 0) {
			errors.push("At least one firmware upgrade must be provided.");
		}
		if (errors.length > 0) {
			await failWithErrors(errors);
		}

		const branchName = `firmware-submission/issue-${issueNumber}`;

		console.log(`Setting up branch ${branchName}...`);
		git("config", "user.name", "zwave-js-bot");
		git("config", "user.email", "zwave-js-bot@users.noreply.github.com");
		// Use BOT_TOKEN for git operations so pushes are attributed to
		// zwave-js-bot and trigger workflows. The default GITHUB_TOKEN
		// credentials set up by actions/checkout do not trigger workflows.
		const botToken = getRequiredEnv("BOT_TOKEN");
		git(
			"remote",
			"set-url",
			"origin",
			`https://x-access-token:${botToken}@github.com/${owner}/${repo}.git`,
		);
		git("fetch", "origin", "main");
		git("checkout", "-B", branchName, "origin/main");

		const primaryDevice = devices[0]!;
		const brand = primaryDevice.brand;
		const model = primaryDevice.model;
		const safeModel = sanitizePathComponent(model);
		const firmwareVersionMin = primaryDevice.firmwareVersion?.min;
		const firmwareVersionMax = primaryDevice.firmwareVersion?.max;
		const versionRangeSuffix =
			firmwareVersionMin || firmwareVersionMax
				? `_${firmwareVersionMin ?? "0.0"}-${firmwareVersionMax ?? "255.255"}`
				: "";
		const fileName = `${safeModel}${versionRangeSuffix}.json`;
		const submittedDevices = devices.map((device) => normalizeDevice(device));

		let matchedExistingFile: FirmwareConfigFile | null = null;
		let relativeFilePath = "";
		let absoluteFilePath = "";

		try {
			console.log("Loading existing firmware configs...");
			const firmwareConfigs = loadFirmwareConfigs();
			console.log(`Found ${firmwareConfigs.length} existing config files`);
			const exactMatches = submittedDevices.map((device) =>
				firmwareConfigs.filter((file) =>
					file.devices.some((existingDevice) =>
						sameExactDevice(existingDevice, device),
					),
				),
			);

			const matchedExistingFiles = [...new Set(exactMatches.flat())];
			if (matchedExistingFiles.length > 1) {
				throw new SubmissionValidationError(
					`This submission matches devices in multiple existing firmware files (${matchedExistingFiles.map((file) => file.relativePath).join(", ")}). We cannot determine which file to update. Please split the submission or open a PR directly.`,
				);
			}

			if (matchedExistingFiles.length === 1) {
				matchedExistingFile = matchedExistingFiles[0]!;
				console.log(`Exact device match found: ${matchedExistingFile.relativePath}`);
				const matchingDeviceCount = submittedDevices.filter((device) =>
					matchedExistingFile!.devices.some((existingDevice) =>
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
				console.log("No exact device match, creating new file");
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
			}
			throw error;
		}

		const existingConfig = matchedExistingFile?.config ?? null;

		console.log("Downloading firmware files and computing hashes...");
		const upgradeHashes: FirmwareHash[][] = [];
		for (const upgrade of upgradeFormData) {
			const urls = [
				upgrade.urlTarget0,
				upgrade.urlTarget1,
				upgrade.urlTarget2,
			].filter((url): url is string => url != null);
			const hashes: FirmwareHash[] = [];

			for (const url of urls) {
				console.log(`  Downloading ${url}...`);
				let filename: string;
				let rawData: Uint8Array | Buffer;
				try {
					({ filename, rawData } = await downloadFirmware(url));
				} catch (error) {
					await failWithErrors([
						`Failed to download firmware from ${url}: ${getErrorMessage(error)}`,
					]);
				}

				let integrity: string;
				try {
					integrity = generateHash(filename!, Buffer.from(rawData!));
				} catch (error) {
					await failWithErrors([
						`Failed to compute integrity hash for ${url}: ${getErrorMessage(error)}`,
					]);
				}

				hashes.push({ url, integrity: integrity! });
			}

			upgradeHashes.push(hashes);
		}

		const prettierConfig = (await prettier.resolveConfig(workspaceRoot)) ?? {};
		const formattedChangelogs: string[] = [];
		for (const upgrade of upgradeFormData) {
			const raw = upgrade.changelog.trim().replace(/\r\n/g, "\n");
			try {
				const formatted = await prettier.format(raw, {
					...prettierConfig,
					parser: "markdown",
				});
				formattedChangelogs.push(formatted.trim());
			} catch {
				formattedChangelogs.push(raw);
			}
		}

		const newUpgrades = upgradeFormData.map((upgrade, index) => {
			const hashes = upgradeHashes[index]!;
			const changelog = formattedChangelogs[index]!;
			const hasMultipleTargets =
				upgrade.urlTarget1 != null || upgrade.urlTarget2 != null;

			const entry: Record<string, any> = {};
			if (upgrade.ifCondition) {
				entry.$if = upgrade.ifCondition;
			}
			entry.version = upgrade.version;
			entry.changelog = changelog;
			if (upgrade.channel && upgrade.channel !== "stable") {
				entry.channel = upgrade.channel;
			}
			if (upgrade.region) {
				entry.region = upgrade.region;
			}

			if (hasMultipleTargets) {
				entry.files = hashes.map(({ url, integrity }, targetIndex) => ({
					target: targetIndex,
					url,
					integrity,
				}));
			} else {
				entry.url = hashes[0]!.url;
				entry.integrity = hashes[0]!.integrity;
			}

			return entry;
		});

		const submittedVersions = newUpgrades.map((upgrade) => upgrade.version);
		const duplicateSubmitted = submittedVersions.filter(
			(version, index) => submittedVersions.indexOf(version) !== index,
		);
		if (duplicateSubmitted.length > 0) {
			await failWithErrors([
				`Version(s) ${[...new Set(duplicateSubmitted)].join(", ")} appear multiple times in this submission. Each upgrade must have a unique version.`,
			]);
		}

		if (existingConfig) {
			const existingVersions = new Set(
				(existingConfig.upgrades ?? [])
					.map((upgrade: { version?: unknown }) =>
						typeof upgrade?.version === "string" ? upgrade.version : null,
					)
					.filter(
						(version: string | null): version is string => version != null,
					),
			);
			const duplicates = newUpgrades
				.filter((upgrade) => existingVersions.has(upgrade.version))
				.map((upgrade) => upgrade.version);
			if (duplicates.length > 0) {
				await failWithErrors([
					`Version(s) ${duplicates.join(", ")} already exist in ${relativeFilePath}. To update an existing entry, please submit a PR directly.`,
				]);
			}
		}

		const config = existingConfig
			? {
					...existingConfig,
					upgrades: [...(existingConfig.upgrades ?? []), ...newUpgrades],
				}
			: {
					devices: devices.map((device) => {
						const entry: Record<string, any> = {
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

		console.log(`Writing config to ${relativeFilePath}...`);
		fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
		fs.writeFileSync(
			absoluteFilePath,
			`${JSON.stringify(config, null, "\t")}\n`,
			"utf-8",
		);

		git("add", relativeFilePath);
		const lastVersion = upgradeFormData[upgradeFormData.length - 1]!.version;
		const commitMessage = `Add ${brand} ${model} firmware v${lastVersion}`;
		console.log(`Committing: ${commitMessage}`);
		git("commit", "-m", commitMessage);
		console.log(`Pushing to origin/${branchName}...`);
		git("push", "--force", "origin", branchName);

		const { data: existingPRs } = await botOctokit.rest.pulls.list({
			owner,
			repo,
			head: `${owner}:${branchName}`,
			state: "open",
		});

		let prUrl: string;
		if (existingPRs.length > 0) {
			prUrl = existingPRs[0]!.html_url;
			console.log(`Existing PR found: ${prUrl}`);
		} else {
			const prTitle = `Add ${brand} ${model} firmware v${lastVersion}`;
			const { data: newPR } = await botOctokit.rest.pulls.create({
				owner,
				repo,
				title: prTitle,
				head: branchName,
				base: "main",
				body: createSubmissionPRBody(issueNumber),
			});
			prUrl = newPR.html_url;
			console.log(`Created PR: ${prUrl}`);
		}

		console.log("Posting status comment...");
		await postStatusComment(
			`Your submission has been processed and a [pull request](${prUrl}) has been created. I'll post the CI check results here once they complete.`,
		);
		console.log("Done!");
	} catch (error) {
		if (error instanceof SubmissionHandledError) {
			throw error;
		}

		console.error(error);
		try {
			await removeLabel("processing");
			await addLabel("checks-failed");
			await postStatusComment(
				`An unexpected error occurred while processing your submission:\n\n\`\`\`\n${getErrorMessage(error)}\n\`\`\`\n\nPlease ask a maintainer to investigate.`,
			);
		} catch {
			// Ignore secondary errors.
		}
		throw error;
	}
}
