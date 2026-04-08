import * as githubActions from "@actions/github";
import { downloadFirmware, generateHash } from "@zwave-js/firmware-integrity";
import {
	parse as parseCommentJson,
	stringify as stringifyCommentJson,
} from "comment-json";
import JSON5 from "json5";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import semver from "semver";
import type { GitHubScriptContext } from "../types.mts";
import {
	createSubmissionPRBody,
	postStatusComment as postStatusCommentShared,
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
const MAX_TARGETS = 3;
const VALID_TARGET_NUMBERS = [0, 1, 2] as const;

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
	files: UpgradeFileFormData[];
}

interface UpgradeFileFormData {
	target: number;
	url: string;
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

function getChipLabel(chipIndex: number): string {
	return `Chip ${chipIndex + 1}`;
}

function getUrlFieldLabel(chipIndex: number, upgradeIndex: number): string {
	if (upgradeIndex === 1) {
		return `Firmware URL (${getChipLabel(chipIndex)})`;
	}
	return `Firmware URL (${getChipLabel(chipIndex)}) (Upgrade ${upgradeIndex})`;
}

function getTargetNumberFieldLabel(
	chipIndex: number,
	upgradeIndex: number,
): string {
	if (upgradeIndex === 1) {
		return `Target Number (${getChipLabel(chipIndex)})`;
	}
	return `Target Number (${getChipLabel(chipIndex)}) (Upgrade ${upgradeIndex})`;
}

function getSingleTargetUrlFieldLabel(upgradeIndex: number): string {
	if (upgradeIndex === 1) {
		return "Firmware URL";
	}
	return `Firmware URL (Upgrade ${upgradeIndex})`;
}

function getSingleTargetTargetNumberFieldLabel(upgradeIndex: number): string {
	if (upgradeIndex === 1) {
		return "Target Number";
	}
	return `Target Number (Upgrade ${upgradeIndex})`;
}

type IssueFileLayout =
	| "multi-target"
	| "single-target"
	| "single-target-with-target"
	| "single-target-chip-1"
	| "single-target-chip-1-with-target";

function buildCanonicalIssueFieldHeadingSequence({
	deviceCount,
	upgradeCount,
	fileLayout,
}: {
	deviceCount: number;
	upgradeCount: number;
	fileLayout: IssueFileLayout;
}): string[] {
	const headings: string[] = [];
	for (let i = 1; i <= deviceCount; i++) {
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
	for (let i = 1; i <= upgradeCount; i++) {
		headings.push(
			getUpgradeFieldLabel("Firmware Version", i),
			getUpgradeFieldLabel("Changelog", i),
			getUpgradeFieldLabel("Channel", i),
			getUpgradeFieldLabel("Region", i),
			getUpgradeFieldLabel("Upgrade conditions", i),
		);

		switch (fileLayout) {
			case "multi-target":
				for (let chipIndex = 0; chipIndex < MAX_TARGETS; chipIndex++) {
					headings.push(
						getTargetNumberFieldLabel(chipIndex, i),
						getUrlFieldLabel(chipIndex, i),
					);
				}
				break;
			case "single-target":
				headings.push(getSingleTargetUrlFieldLabel(i));
				break;
			case "single-target-with-target":
				headings.push(
					getSingleTargetTargetNumberFieldLabel(i),
					getSingleTargetUrlFieldLabel(i),
				);
				break;
			case "single-target-chip-1":
				headings.push(getUrlFieldLabel(0, i));
				break;
			case "single-target-chip-1-with-target":
				headings.push(
					getTargetNumberFieldLabel(0, i),
					getUrlFieldLabel(0, i),
				);
				break;
		}
	}
	return headings;
}

function parseYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

export function extractIssueTemplateFieldHeadings(
	templateBody: string,
): string[] {
	return templateBody
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*label:\s*(.+?)\s*$/)?.[1])
		.filter((label): label is string => label != null)
		.map(parseYamlScalar);
}

function loadIssueTemplateFieldHeadingSequences(): string[][] {
	const issueTemplateDirectory = path.join(
		workspaceRoot,
		".github",
		"ISSUE_TEMPLATE",
	);
	let files: string[];
	try {
		files = fs
			.readdirSync(issueTemplateDirectory)
			.filter((file) => /\.(ya?ml)$/i.test(file))
			.sort();
	} catch {
		return [];
	}

	return files
		.map((file) =>
			extractIssueTemplateFieldHeadings(
				fs.readFileSync(
					path.join(issueTemplateDirectory, file),
					"utf-8",
				),
			),
		)
		.filter((headings) => headings.length > 0);
}

function buildIssueFieldHeadingSequences(): string[][] {
	const sequences = new Set<string>();

	for (const templateHeadings of loadIssueTemplateFieldHeadingSequences()) {
		sequences.add(JSON.stringify(templateHeadings));
	}

	const fileLayouts: IssueFileLayout[] = [
		"multi-target",
		"single-target",
		"single-target-with-target",
		"single-target-chip-1",
		"single-target-chip-1-with-target",
	];
	for (let deviceCount = 1; deviceCount <= MAX_DEVICES; deviceCount++) {
		for (
			let upgradeCount = 1;
			upgradeCount <= MAX_UPGRADES;
			upgradeCount++
		) {
			for (const fileLayout of fileLayouts) {
				sequences.add(
					JSON.stringify(
						buildCanonicalIssueFieldHeadingSequence({
							deviceCount,
							upgradeCount,
							fileLayout,
						}),
					),
				);
			}
		}
	}

	return [...sequences].map((sequence) => JSON.parse(sequence) as string[]);
}

const ISSUE_FIELD_HEADING_SEQUENCES = buildIssueFieldHeadingSequences();

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

export function insertUpgradesToFirmwareConfigText(
	configText: string,
	newUpgrades: readonly Record<string, any>[],
): string {
	const config = parseCommentJson<Record<string, any>>(configText);
	if (!Array.isArray(config.upgrades)) {
		throw new Error("Firmware config does not contain an upgrades array.");
	}

	for (const upgrade of newUpgrades) {
		const newVersion =
			typeof upgrade.version === "string" ? upgrade.version : "";
		const existingUpgrades = config.upgrades as any[];
		// Find the first existing upgrade whose version is strictly lower than
		// the new upgrade's version, so higher versions come first.
		const insertIndex =
			newVersion !== ""
				? existingUpgrades.findIndex(
						(existing) =>
							typeof existing.version === "string" &&
							semver.gt(
								padVersion(newVersion),
								padVersion(existing.version),
							),
					)
				: -1;

		if (insertIndex === -1) {
			config.upgrades.push(upgrade);
		} else {
			existingUpgrades.splice(insertIndex, 0, upgrade);
		}
	}

	return `${stringifyCommentJson(config, null, "\t")}\n`;
}

export async function formatWithPrettier(
	text: string,
	parser: string,
	prettierConfig: Record<string, any> = {},
): Promise<string> {
	return prettier.format(text, {
		...prettierConfig,
		parser,
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
	let candidateSequences = ISSUE_FIELD_HEADING_SEQUENCES.map((headings) => ({
		headings,
		nextHeadingIndex: 0,
	}));

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
		// Only advancing through one of the known heading sequences keeps
		// Markdown headings inside textarea values attached to the current field
		// instead of starting a new one.
		const matchingSequences = heading
			? candidateSequences
					.filter(
						(candidate) =>
							candidate.headings[candidate.nextHeadingIndex] ===
							heading,
					)
					.map((candidate) => ({
						headings: candidate.headings,
						nextHeadingIndex: candidate.nextHeadingIndex + 1,
					}))
			: [];
		if (heading && matchingSequences.length > 0) {
			finalizeSection();
			currentHeading = heading;
			currentLines = [];
			candidateSequences = matchingSequences;
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
	displayLabel = label,
): string | null {
	if (!(label in sections)) {
		if (required) {
			errors.push(
				`Could not find the '${displayLabel}' field. Has the issue body been edited manually?`,
			);
		}
		return null;
	}

	const value = sections[label];
	if (value == null) {
		if (required) {
			errors.push(
				`The '${displayLabel}' field is required but was left blank.`,
			);
		}
		return null;
	}

	return value;
}

function findExistingFieldLabel(
	sections: Record<string, string | null>,
	labels: readonly string[],
): string | null {
	return labels.find((label) => label in sections) ?? null;
}

function getFieldWithAliases({
	sections,
	labels,
	required,
	errors,
	displayLabel = labels[0] ?? "field",
}: {
	sections: Record<string, string | null>;
	labels: readonly string[];
	required: boolean;
	errors: string[];
	displayLabel?: string;
}): { label: string; value: string | null } {
	const label = findExistingFieldLabel(sections, labels) ?? displayLabel;
	return {
		label,
		value: getField(sections, label, required, errors, displayLabel),
	};
}

function peekFieldWithAliases(
	sections: Record<string, string | null>,
	labels: readonly string[],
): string | null {
	const label = findExistingFieldLabel(sections, labels);
	return label != null ? sections[label] : null;
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

function validateTargetNumber(
	value: string,
	fieldName: string,
	errors: string[],
): number | null {
	if (!/^\d+$/.test(value)) {
		errors.push(`'${fieldName}' must be a whole number, got: ${value}`);
		return null;
	}

	const parsed = Number.parseInt(value, 10);
	if (
		!VALID_TARGET_NUMBERS.includes(
			parsed as (typeof VALID_TARGET_NUMBERS)[number],
		)
	) {
		errors.push(
			`'${fieldName}' must be one of ${VALID_TARGET_NUMBERS.join(", ")}, got: ${value}`,
		);
		return null;
	}

	return parsed;
}

function normalizeUpgradeVariant(upgrade: Record<string, any>): {
	version: string;
	channel: "stable" | "beta";
	region: string | null;
	ifCondition: string | null;
} | null {
	if (typeof upgrade.version !== "string" || upgrade.version.length === 0) {
		return null;
	}

	return {
		version: upgrade.version,
		channel: upgrade.channel === "beta" ? "beta" : "stable",
		region: typeof upgrade.region === "string" ? upgrade.region : null,
		ifCondition:
			typeof upgrade.$if === "string" && upgrade.$if.length > 0
				? upgrade.$if
				: null,
	};
}

function getUpgradeVariantKey(
	variant: NonNullable<ReturnType<typeof normalizeUpgradeVariant>>,
): string {
	return JSON.stringify([
		variant.version,
		variant.region,
		variant.ifCondition,
	]);
}

function describeUpgradeVariant(
	variant: NonNullable<ReturnType<typeof normalizeUpgradeVariant>>,
): string {
	const details = [`v${variant.version}`];
	if (variant.channel !== "stable") {
		details.push(`channel ${variant.channel}`);
	}
	if (variant.region != null) {
		details.push(`region ${variant.region}`);
	}
	if (variant.ifCondition != null) {
		details.push(`condition ${sanitizeForMessage(variant.ifCondition)}`);
	}
	return details.join(", ");
}

export function findDuplicateUpgradeVariants(
	existingUpgrades: readonly Record<string, any>[],
	newUpgrades: readonly Record<string, any>[],
): string[] {
	const existingKeys = new Set(
		existingUpgrades
			.map(normalizeUpgradeVariant)
			.filter(
				(
					variant,
				): variant is NonNullable<
					ReturnType<typeof normalizeUpgradeVariant>
				> => variant != null,
			)
			.map(getUpgradeVariantKey),
	);

	const seenNewKeys = new Set<string>();
	const duplicates = new Set<string>();

	for (const upgrade of newUpgrades) {
		const variant = normalizeUpgradeVariant(upgrade);
		if (!variant) continue;

		const key = getUpgradeVariantKey(variant);
		if (existingKeys.has(key) || seenNewKeys.has(key)) {
			duplicates.add(describeUpgradeVariant(variant));
		}
		seenNewKeys.add(key);
	}

	return [...duplicates];
}

export function findDuplicateTargets(
	files: ReadonlyArray<{ target: number }>,
): number[] {
	const seenTargets = new Set<number>();
	const duplicates = new Set<number>();

	for (const file of files) {
		if (seenTargets.has(file.target)) {
			duplicates.add(file.target);
		}
		seenTargets.add(file.target);
	}

	return [...duplicates];
}

interface UpgradeFileFieldDescriptor {
	urlLabels: string[];
	targetLabels: string[];
	required: boolean;
	defaultTarget: number;
	displayLabel: string;
}

function getUpgradeFileFieldDescriptors(
	upgradeIndex: number,
): UpgradeFileFieldDescriptor[] {
	return [
		{
			urlLabels: [
				getUrlFieldLabel(0, upgradeIndex),
				getSingleTargetUrlFieldLabel(upgradeIndex),
			],
			targetLabels: [
				getTargetNumberFieldLabel(0, upgradeIndex),
				getSingleTargetTargetNumberFieldLabel(upgradeIndex),
			],
			required: true,
			defaultTarget: 0,
			displayLabel: getSingleTargetUrlFieldLabel(upgradeIndex),
		},
		...Array.from({ length: MAX_TARGETS - 1 }, (_, offset) => {
			const chipIndex = offset + 1;
			return {
				urlLabels: [getUrlFieldLabel(chipIndex, upgradeIndex)],
				targetLabels: [
					getTargetNumberFieldLabel(chipIndex, upgradeIndex),
				],
				required: false,
				defaultTarget: chipIndex,
				displayLabel: getUrlFieldLabel(chipIndex, upgradeIndex),
			};
		}),
	];
}

export function parseUpgradeFilesFromSections({
	sections,
	upgradeIndex,
	errors,
}: {
	sections: Record<string, string | null>;
	upgradeIndex: number;
	errors: string[];
}): UpgradeFileFormData[] {
	const files: UpgradeFileFormData[] = [];
	const singleTargetUrlLabel = getSingleTargetUrlFieldLabel(upgradeIndex);
	for (const descriptor of getUpgradeFileFieldDescriptors(upgradeIndex)) {
		const { label: urlLabel, value: url } = getFieldWithAliases({
			sections,
			labels: descriptor.urlLabels,
			required: descriptor.required,
			errors,
			displayLabel: descriptor.displayLabel,
		});
		if (!url) continue;

		validateUrl(url, urlLabel, errors);

		const { label: targetLabel, value: targetRaw } = getFieldWithAliases({
			sections,
			labels: descriptor.targetLabels,
			required: false,
			errors,
			displayLabel:
				descriptor.defaultTarget === 0
					? getSingleTargetTargetNumberFieldLabel(upgradeIndex)
					: descriptor.targetLabels[0],
		});
		if (urlLabel === singleTargetUrlLabel && targetRaw != null) {
			errors.push(
				`'${targetLabel}' is not supported in the single-target submission form. That form always uses target number 0. Use the 'Firmware Submission' form instead.`,
			);
		}
		const target =
			targetRaw != null && urlLabel !== singleTargetUrlLabel
				? (validateTargetNumber(targetRaw, targetLabel, errors) ??
					descriptor.defaultTarget)
				: descriptor.defaultTarget;

		files.push({ target, url });
	}

	return files;
}

export function createUpgradeEntry({
	version,
	changelog,
	channel,
	region,
	ifCondition,
	files,
}: {
	version: string;
	changelog: string;
	channel: "stable" | "beta" | null;
	region: string | null;
	ifCondition: string | null;
	files: ReadonlyArray<{
		target: number;
		url: string;
		integrity: string;
	}>;
}): Record<string, any> {
	const entry: Record<string, any> = {};
	if (ifCondition) {
		entry.$if = ifCondition;
	}
	entry.version = version;
	entry.changelog = changelog;
	if (channel && channel !== "stable") {
		entry.channel = channel;
	}
	if (region) {
		entry.region = region;
	}

	if (files.length > 1 || files[0]?.target !== 0) {
		entry.files = files.map(({ target, url, integrity }) => ({
			target,
			url,
			integrity,
		}));
	} else {
		entry.url = files[0]!.url;
		entry.integrity = files[0]!.integrity;
	}

	return entry;
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

	const postStatusComment = async (body: string): Promise<void> => {
		await postStatusCommentShared(
			botOctokit,
			owner,
			repo,
			issueNumber,
			body,
		);
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
			// Dropdown fields (Channel, Region, Target Number) always have a
			// default value in GitHub issue forms, so they must not be used for
			// this check.
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
					...getUpgradeFileFieldDescriptors(i).map((descriptor) =>
						peekFieldWithAliases(sections, descriptor.urlLabels),
					),
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

			let channel: "stable" | "beta" | null = null;
			let region: string | null = null;

			if (version) {
				validateVersion(
					version,
					getUpgradeFieldLabel("Firmware Version", i),
					errors,
				);
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

			const files = parseUpgradeFilesFromSections({
				sections,
				upgradeIndex: i,
				errors,
			});

			const duplicateTargets = findDuplicateTargets(files);
			if (duplicateTargets.length > 0) {
				errors.push(
					`Upgrade ${i} uses target number(s) ${duplicateTargets.join(", ")} more than once. Each firmware file must have a unique target number.`,
				);
			}

			if (!(version && changelog && channelRaw && files.length > 0)) {
				continue;
			}

			upgradeFormData.push({
				index: i,
				version,
				changelog,
				channel,
				region,
				ifCondition,
				files,
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
			const hashes: FirmwareHash[] = [];

			for (const file of upgrade.files) {
				const { url } = file;
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
			(await prettier.resolveConfig(absoluteFilePath)) ?? {};
		const formattedChangelogs: string[] = [];
		for (const upgrade of upgradeFormData) {
			const raw = upgrade.changelog.trim().replace(/\r\n/g, "\n");
			try {
				const formatted = await formatWithPrettier(
					raw,
					"markdown",
					prettierConfig,
				);
				formattedChangelogs.push(formatted.trim());
			} catch {
				formattedChangelogs.push(raw);
			}
		}

		const newUpgrades = upgradeFormData.map((upgrade, index) => {
			const hashes = upgradeHashes[index]!;
			const changelog = formattedChangelogs[index]!;
			return createUpgradeEntry({
				version: upgrade.version,
				changelog,
				channel: upgrade.channel,
				region: upgrade.region,
				ifCondition: upgrade.ifCondition,
				files: upgrade.files.map((file, fileIndex) => ({
					target: file.target,
					url: file.url,
					integrity: hashes[fileIndex]!.integrity,
				})),
			});
		});

		const duplicateVariants = findDuplicateUpgradeVariants(
			existingConfig?.upgrades ?? [],
			newUpgrades,
		);
		if (duplicateVariants.length > 0) {
			const locationMessage = existingConfig
				? `in the submission or already in ${relativeFilePath}`
				: "in the submission";
			await failWithErrors([
				`Duplicate upgrade variant(s) were found ${locationMessage}: ${duplicateVariants.join("; ")}. Please keep each version/region/condition combination unique, and do not publish the same version on multiple channels. If you need to update an existing entry, submit a PR.`,
			]);
		}

		const configText = matchedExistingFile
			? insertUpgradesToFirmwareConfigText(
					fs.readFileSync(matchedExistingFile.absolutePath, "utf-8"),
					newUpgrades,
				)
			: `${stringifyCommentJson(
					{
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
					},
					null,
					"\t",
				)}\n`;
		const formattedConfigText = await formatWithPrettier(
			configText,
			"json",
			prettierConfig,
		);

		console.log(
			"Re-checking approved issue state before writing changes...",
		);
		await ensureIssueStillApproved(true);
		console.log(`Writing config to ${relativeFilePath}...`);
		fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
		fs.writeFileSync(absoluteFilePath, formattedConfigText, "utf-8");

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
