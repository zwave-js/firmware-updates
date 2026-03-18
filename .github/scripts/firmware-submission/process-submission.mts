import * as githubActions from "@actions/github";
import { downloadFirmware, generateHash } from "@zwave-js/firmware-integrity";
import JSON5 from "json5";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import semver from "semver";
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

const MAX_DEVICES = 3;
const MAX_UPGRADES = 4;

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

function getDeviceFieldLabel(name: string, index: number): string {
	return index === 1 ? name : `${name} (Device ${index})`;
}

function getUpgradeFieldLabel(name: string, index: number): string {
	return index === 1 ? name : `${name} (Upgrade ${index})`;
}

function getUrlFieldLabel(targetIndex: number, upgradeIndex: number): string {
	if (upgradeIndex === 1) {
		return `Firmware URL (Target ${targetIndex})`;
	}
	return `Firmware URL (Target ${targetIndex}) (Upgrade ${upgradeIndex})`;
}

function buildIssueFieldHeadings(): string[] {
	const headings: string[] = [];
	for (let i = 1; i <= MAX_DEVICES; i++) {
		headings.push(
			getDeviceFieldLabel("Brand", i),
			getDeviceFieldLabel("Model", i),
			getDeviceFieldLabel("Manufacturer ID", i),
			getDeviceFieldLabel("Product Type", i),
			getDeviceFieldLabel("Product ID", i),
			getDeviceFieldLabel("Firmware Version (Min)", i),
			getDeviceFieldLabel("Firmware Version (Max)", i),
		);
	}
	for (let i = 1; i <= MAX_UPGRADES; i++) {
		headings.push(
			getUpgradeFieldLabel("Firmware Version", i),
			getUpgradeFieldLabel("Changelog", i),
			getUpgradeFieldLabel("Channel", i),
			getUpgradeFieldLabel("Region", i),
			getUpgradeFieldLabel("Upgrade conditions", i),
			getUrlFieldLabel(0, i),
			getUrlFieldLabel(1, i),
			getUrlFieldLabel(2, i),
		);
	}
	return headings;
}

const ISSUE_FIELD_HEADINGS = buildIssueFieldHeadings();

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
	return sanitizePathComponent(brand.replace(/\s+/g, "-")).toLowerCase();
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

function exactDeviceKey(device: NormalizedDevice): string {
	return [
		device.manufacturerId,
		device.productType,
		device.productId,
		device.firmwareVersion.min,
		device.firmwareVersion.max,
	].join(":");
}

export function sameExactDeviceSet(
	left: readonly NormalizedDevice[],
	right: readonly NormalizedDevice[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const leftKeys = [...left].map(exactDeviceKey).sort();
	const rightKeys = [...right].map(exactDeviceKey).sort();
	return leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameBaseDevice(
	left: NormalizedDevice,
	right: NormalizedDevice,
): boolean {
	return (
		left.manufacturerId === right.manufacturerId &&
		left.productType === right.productType &&
		left.productId === right.productId
	);
}

function padVersion(version: string): string {
	return version.split(".").length === 3 ? version : `${version}.0`;
}

function rangesOverlap(
	a: FirmwareVersionRange,
	b: FirmwareVersionRange,
): boolean {
	return (
		semver.compare(padVersion(a.min), padVersion(b.max)) <= 0 &&
		semver.compare(padVersion(b.min), padVersion(a.max)) <= 0
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
	// the existing directory (e.g. "Enbrighten/GE" → "enbrighten-ge" vs
	// existing "enbrighten_ge"). Fall back to checking whether the brand
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
							existingDevice.manufacturerId ===
							device.manufacturerId,
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
				.map((device) =>
					findPreferredDirectoryForDevice(device, firmwareConfigs),
				)
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
		throw new Error(
			"Workflow event payload does not match the submission issue.",
		);
	}

	return payload.issue;
}

export function parseIssueBody(body: string): Record<string, string | null> {
	const sections: Record<string, string | null> = {};
	const lines = body.split(/\r?\n/);
	let currentHeading: string | null = null;
	let currentLines: string[] = [];
	let nextHeadingIndex = 0;

	const finalizeSection = (): void => {
		if (!currentHeading) return;
		const value = currentLines.join("\n").trim();
		sections[currentHeading] =
			value === "_No response_" || value === "" ? null : value;
	};

	for (const line of lines) {
		const match = line.match(/^### (.+)$/);
		const heading = match?.[1]?.trim();
		// GitHub issue forms render each field as `### <label>` in a fixed order.
		// Only advancing through that known sequence keeps Markdown headings inside
		// textarea values attached to the current field instead of starting a new one.
		if (heading && heading === ISSUE_FIELD_HEADINGS[nextHeadingIndex]) {
			finalizeSection();
			currentHeading = heading;
			currentLines = [];
			nextHeadingIndex++;
			continue;
		}
		if (!currentHeading) continue;
		if (currentLines.length === 0 && line.trim() === "") {
			continue;
		}
		currentLines.push(line);
	}

	finalizeSection();
	return sections;
}

function getIssueLabelNames(
	labels: ReadonlyArray<string | { name?: string | null }>,
): string[] {
	return labels.map((label) =>
		typeof label === "string" ? label : (label.name ?? ""),
	);
}

export function getApprovalInvalidReason({
	approvedBody,
	currentBody,
	labelNames,
	requireProcessing = false,
}: {
	approvedBody: string;
	currentBody: string | null | undefined;
	labelNames: readonly string[];
	requireProcessing?: boolean;
}): string | null {
	if ((currentBody ?? "") !== approvedBody) {
		return "Submission body no longer matches the approved snapshot.";
	}
	if (!labelNames.includes("approved")) {
		return "Submission is no longer approved.";
	}
	if (labelNames.includes("pending-approval")) {
		return "Submission was reset to pending approval.";
	}
	if (requireProcessing && !labelNames.includes("processing")) {
		return "Submission is no longer marked as processing.";
	}
	return null;
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

function validateHex(
	value: string,
	fieldName: string,
	errors: string[],
): boolean {
	if (!hexRegex.test(value)) {
		errors.push(
			`'${fieldName}' must be a 4-digit hex value (e.g. 0x001d), got: ${value}`,
		);
		return false;
	}
	return true;
}

function validateName(
	value: string,
	fieldName: string,
	errors: string[],
): boolean {
	if (/\.\./.test(value) || value.includes("\\")) {
		errors.push(`'${fieldName}' contains invalid characters.`);
		return false;
	}
	return true;
}

function sanitizePathComponent(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/[_-]{2,}/g, "-")
		.replace(/^[_-]+|[_-]+$/g, "");
}

function sanitizeForMessage(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 100);
}

function isIpAddress(hostname: string): boolean {
	// IPv4
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
	// IPv6 (bracketed form is stripped by URL parser)
	if (hostname.includes(":")) return true;
	return false;
}

function validateUrl(
	value: string,
	fieldName: string,
	errors: string[],
): boolean {
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
	if (parsed.username || parsed.password) {
		errors.push(`'${fieldName}' must not contain credentials.`);
		return false;
	}
	if (isIpAddress(parsed.hostname)) {
		errors.push(
			`'${fieldName}' must use a domain name, not an IP address.`,
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
		throw new Error(
			"Workflow event payload does not contain an issue number.",
		);
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
		const comments = await botOctokit.paginate(
			botOctokit.rest.issues.listComments,
			{
				owner,
				repo,
				issue_number: issueNumber,
			},
		);

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

		const errorList = errors
			.map((error, index) => `${index + 1}. ${error}`)
			.join("\n");
		await postStatusComment(
			`There were problems with your submission:\n\n${errorList}\n\nPlease edit the issue body to fix these issues, then ask a maintainer to re-trigger processing.`,
		);

		throw new SubmissionHandledError(errors.join("; "));
	};

	const failBecauseIssueChangedAfterApproval = async (): Promise<never> => {
		await removeLabel("processing");
		await addLabel("checks-failed");
		await postStatusComment(
			"This submission changed after it was approved, or its approval was reset, so processing was skipped. Please ask a maintainer to review the current issue body and re-apply the `approved` label before processing again.",
		);
		throw new SubmissionHandledError(
			"Submission changed after approval or approval was reset.",
		);
	};

	try {
		console.log(`Processing firmware submission issue #${issueNumber}`);

		const approvedIssue = loadApprovedIssueSnapshot(issueNumber);
		const approvedBody = approvedIssue?.body ?? "";
		const ensureIssueStillApproved = async (
			requireProcessingLabel = false,
		): Promise<void> => {
			const { data: issue } = await github.rest.issues.get({
				owner,
				repo,
				issue_number: issueNumber,
			});
			const invalidReason = getApprovalInvalidReason({
				approvedBody,
				currentBody: issue.body,
				labelNames: getIssueLabelNames(issue.labels),
				requireProcessing: requireProcessingLabel,
			});
			if (invalidReason != null) {
				console.log(invalidReason);
				await failBecauseIssueChangedAfterApproval();
			}
		};

		console.log("Checking if the approved issue state is still valid...");
		await ensureIssueStillApproved();

		// Reset to a consistent label state before processing.
		await removeLabel("pending-approval");
		await removeLabel("submitted");
		await removeLabel("checks-failed");
		await addLabel("processing");
		console.log("Parsing issue body...");
		const sections = parseIssueBody(approvedBody);
		const errors: string[] = [];

		const hasAnyValue = (values: Array<string | null>): boolean =>
			values.some((value) => value != null);

		const parseDevice = (index: number): SubmissionDevice | null => {
			const started =
				index === 1 ||
				hasAnyValue([
					getField(
						sections,
						getDeviceFieldLabel("Brand", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Model", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Manufacturer ID", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Product Type", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Product ID", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Firmware Version (Min)", index),
						false,
						errors,
					),
					getField(
						sections,
						getDeviceFieldLabel("Firmware Version (Max)", index),
						false,
						errors,
					),
				]);

			if (!started) {
				return null;
			}

			const brand = getField(
				sections,
				getDeviceFieldLabel("Brand", index),
				true,
				errors,
			);
			const model = getField(
				sections,
				getDeviceFieldLabel("Model", index),
				true,
				errors,
			);
			const manufacturerId = getField(
				sections,
				getDeviceFieldLabel("Manufacturer ID", index),
				true,
				errors,
			);
			const productType = getField(
				sections,
				getDeviceFieldLabel("Product Type", index),
				true,
				errors,
			);
			const productId = getField(
				sections,
				getDeviceFieldLabel("Product ID", index),
				true,
				errors,
			);
			const firmwareVersionMin = getField(
				sections,
				getDeviceFieldLabel("Firmware Version (Min)", index),
				false,
				errors,
			);
			const firmwareVersionMax = getField(
				sections,
				getDeviceFieldLabel("Firmware Version (Max)", index),
				false,
				errors,
			);

			if (brand)
				validateName(
					brand,
					getDeviceFieldLabel("Brand", index),
					errors,
				);
			if (model)
				validateName(
					model,
					getDeviceFieldLabel("Model", index),
					errors,
				);
			if (manufacturerId) {
				validateHex(
					manufacturerId,
					getDeviceFieldLabel("Manufacturer ID", index),
					errors,
				);
			}
			if (productType) {
				validateHex(
					productType,
					getDeviceFieldLabel("Product Type", index),
					errors,
				);
			}
			if (productId) {
				validateHex(
					productId,
					getDeviceFieldLabel("Product ID", index),
					errors,
				);
			}
			if (firmwareVersionMin) {
				validateVersion(
					firmwareVersionMin,
					getDeviceFieldLabel("Firmware Version (Min)", index),
					errors,
				);
			}
			if (firmwareVersionMax) {
				validateVersion(
					firmwareVersionMax,
					getDeviceFieldLabel("Firmware Version (Max)", index),
					errors,
				);
			}

			if (
				!(brand && model && manufacturerId && productType && productId)
			) {
				return null;
			}

			const device: SubmissionDevice = {
				brand,
				model,
				manufacturerId: manufacturerId.toLowerCase(),
				productType: productType.toLowerCase(),
				productId: productId.toLowerCase(),
			};
			// Normalize: "0.0" for min and "255.255" for max are the same
			// as leaving the field blank (= applies to all versions).
			const effectiveMin =
				firmwareVersionMin && firmwareVersionMin !== "0.0"
					? firmwareVersionMin
					: null;
			const effectiveMax =
				firmwareVersionMax && firmwareVersionMax !== "255.255"
					? firmwareVersionMax
					: null;
			if (effectiveMin || effectiveMax) {
				device.firmwareVersion = {
					min: effectiveMin ?? "0.0",
					max: effectiveMax ?? "255.255",
				};
			}
			return device;
		};

		const devices = [parseDevice(1), parseDevice(2), parseDevice(3)].filter(
			(device): device is SubmissionDevice => device != null,
		);
		console.log(
			`Parsed ${devices.length} device(s):`,
			devices
				.map(
					(d) =>
						`${d.brand} ${d.model} (${d.manufacturerId}/${d.productType}/${d.productId})`,
				)
				.join(", "),
		);

		const upgradeFormData: UpgradeFormData[] = [];
		for (let i = 1; i <= MAX_UPGRADES; i++) {
			// Only check free text fields to determine if an upgrade was started.
			// Dropdown fields (Channel, Region) always have a default value in
			// GitHub issue forms, so they must not be used for this check.
			const started =
				i === 1 ||
				hasAnyValue([
					getField(
						sections,
						getUpgradeFieldLabel("Firmware Version", i),
						false,
						errors,
					),
					getField(
						sections,
						getUpgradeFieldLabel("Changelog", i),
						false,
						errors,
					),
					getField(
						sections,
						getUpgradeFieldLabel("Upgrade conditions", i),
						false,
						errors,
					),
					getField(sections, getUrlFieldLabel(0, i), false, errors),
					getField(sections, getUrlFieldLabel(1, i), false, errors),
					getField(sections, getUrlFieldLabel(2, i), false, errors),
				]);

			if (!started) {
				continue;
			}

			const version = getField(
				sections,
				getUpgradeFieldLabel("Firmware Version", i),
				true,
				errors,
			);
			const changelog = getField(
				sections,
				getUpgradeFieldLabel("Changelog", i),
				true,
				errors,
			);
			const channelRaw = getField(
				sections,
				getUpgradeFieldLabel("Channel", i),
				true,
				errors,
			);
			const regionRaw = getField(
				sections,
				getUpgradeFieldLabel("Region", i),
				false,
				errors,
			);
			const ifCondition = getField(
				sections,
				getUpgradeFieldLabel("Upgrade conditions", i),
				false,
				errors,
			);
			const urlTarget0 = getField(
				sections,
				getUrlFieldLabel(0, i),
				true,
				errors,
			);
			const urlTarget1 = getField(
				sections,
				getUrlFieldLabel(1, i),
				false,
				errors,
			);
			const urlTarget2 = getField(
				sections,
				getUrlFieldLabel(2, i),
				false,
				errors,
			);

			let channel: "stable" | "beta" | null = null;
			let region: string | null = null;

			if (version) {
				validateVersion(
					version,
					getUpgradeFieldLabel("Firmware Version", i),
					errors,
				);
			}
			if (urlTarget0) {
				validateUrl(urlTarget0, getUrlFieldLabel(0, i), errors);
			}
			if (urlTarget1) {
				validateUrl(urlTarget1, getUrlFieldLabel(1, i), errors);
			}
			if (urlTarget2) {
				validateUrl(urlTarget2, getUrlFieldLabel(2, i), errors);
			}

			if (channelRaw) {
				if (channelRaw === "stable" || channelRaw === "beta") {
					channel = channelRaw;
				} else {
					errors.push(
						`'${getUpgradeFieldLabel("Channel", i)}' must be 'stable' or 'beta', got: ${channelRaw}`,
					);
				}
			}

			if (regionRaw && regionRaw !== "All regions") {
				if (
					VALID_REGIONS.includes(
						regionRaw as (typeof VALID_REGIONS)[number],
					)
				) {
					region = regionRaw;
				} else {
					errors.push(
						`'${getUpgradeFieldLabel("Region", i)}' is not a valid region: ${regionRaw}`,
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

		console.log(
			`Parsed ${upgradeFormData.length} upgrade(s):`,
			upgradeFormData
				.map((u) => `v${u.version} (${u.channel ?? "stable"})`)
				.join(", "),
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
		// Set the token via http.extraHeader to avoid leaking it in URLs
		// that git may print in error messages.
		const botToken = getRequiredEnv("BOT_TOKEN");
		git(
			"remote",
			"set-url",
			"origin",
			`https://github.com/${owner}/${repo}.git`,
		);
		git(
			"config",
			"http.https://github.com/.extraheader",
			`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${botToken}`).toString("base64")}`,
		);
		git("fetch", "origin", "main");
		// Fetch the submission branch too (if it exists) so that
		// --force-with-lease has a reference point for the remote state.
		try {
			git("fetch", "origin", branchName);
		} catch {
			// Branch may not exist yet on the remote.
		}
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
		const submittedDevices = devices.map((device) =>
			normalizeDevice(device),
		);

		let matchedExistingFile: FirmwareConfigFile | null = null;
		let relativeFilePath = "";
		let absoluteFilePath = "";

		try {
			console.log("Loading existing firmware configs...");
			const firmwareConfigs = loadFirmwareConfigs();
			console.log(
				`Found ${firmwareConfigs.length} existing config files`,
			);
			// Reuse an existing file only when the submitted device identifiers match
			// its full normalized device set exactly.
			const matchedExistingFiles = firmwareConfigs.filter((file) =>
				sameExactDeviceSet(file.devices, submittedDevices),
			);
			if (matchedExistingFiles.length > 1) {
				throw new SubmissionValidationError(
					`This submission matches devices in multiple existing firmware files (${matchedExistingFiles.map((file) => file.relativePath).join(", ")}). We cannot determine which file to update. Please split the submission or open a PR directly.`,
				);
			}

			if (matchedExistingFiles.length === 1) {
				matchedExistingFile = matchedExistingFiles[0]!;
				console.log(
					`Exact device match found: ${matchedExistingFile.relativePath}`,
				);
				relativeFilePath = matchedExistingFile.relativePath;
				absoluteFilePath = matchedExistingFile.absolutePath;
			} else {
				const partialExactMatches = firmwareConfigs.filter((file) =>
					file.devices.some((existingDevice) =>
						submittedDevices.some((device) =>
							sameExactDevice(existingDevice, device),
						),
					),
				);
				if (partialExactMatches.length > 0) {
					throw new SubmissionValidationError(
						`The submitted devices only partially match existing firmware file(s) (${partialExactMatches.map((file) => file.relativePath).join(", ")}). Reusing one of those files could introduce unwanted upgrade paths. Please split the submission or open a PR directly.`,
					);
				}

				// No exact match — check if existing files have the same
				// base device IDs with an overlapping firmware version range.
				// This catches the case where a submitter leaves min/max blank
				// (defaulting to 0.0–255.255) but an existing config has a
				// specific range like 2.0–7.0.
				const overlappingFiles = firmwareConfigs.filter((file) =>
					submittedDevices.some((device) =>
						file.devices.some(
							(existing) =>
								sameBaseDevice(existing, device) &&
								rangesOverlap(
									existing.firmwareVersion,
									device.firmwareVersion,
								),
						),
					),
				);
				if (overlappingFiles.length > 0) {
					const fileList = overlappingFiles
						.map((f) => f.relativePath)
						.join(", ");
					throw new SubmissionValidationError(
						`The submitted device identifiers match existing firmware file(s) (${fileList}), but with a different firmware version range. Please adjust the firmware version range to match exactly, or open a PR directly.`,
					);
				}

				console.log("No exact device match, creating new file");
				const brandDir = determineNewFileDirectory(
					submittedDevices,
					firmwareConfigs,
				);
				relativeFilePath = path.posix.join(
					"firmwares",
					brandDir,
					fileName,
				);
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

		const prettierConfig =
			(await prettier.resolveConfig(workspaceRoot)) ?? {};
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

		if (existingConfig) {
			const existingVersions = new Set(
				(existingConfig.upgrades ?? [])
					.map((upgrade: { version?: unknown }) =>
						typeof upgrade?.version === "string"
							? upgrade.version
							: null,
					)
					.filter(
						(version: string | null): version is string =>
							version != null,
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
					upgrades: [
						...(existingConfig.upgrades ?? []),
						...newUpgrades,
					],
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

		console.log(
			"Re-checking approved issue state before writing changes...",
		);
		await ensureIssueStillApproved(true);
		console.log(`Writing config to ${relativeFilePath}...`);
		fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
		fs.writeFileSync(
			absoluteFilePath,
			`${JSON.stringify(config, null, "\t")}\n`,
			"utf-8",
		);

		git("add", relativeFilePath);
		const lastVersion =
			upgradeFormData[upgradeFormData.length - 1]!.version;
		const safeBrand = sanitizeForMessage(brand);
		const safeModelName = sanitizeForMessage(model);
		const commitMessage = `Add ${safeBrand} ${safeModelName} firmware v${lastVersion}`;
		console.log(`Committing: ${commitMessage}`);
		git("commit", "-m", commitMessage);
		console.log(
			"Re-checking approved issue state before pushing changes...",
		);
		await ensureIssueStillApproved(true);
		console.log(`Pushing to origin/${branchName}...`);
		git("push", "--force-with-lease", "origin", branchName);

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
			const prTitle = `Add ${safeBrand} ${safeModelName} firmware v${lastVersion}`;
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
