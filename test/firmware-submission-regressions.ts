import test from "ava";
import JSON5 from "json5";
import { readFile } from "node:fs/promises";

const processSubmissionModulePath =
	"../.github/scripts/firmware-submission/process-submission.mts";
const mirrorPrChecksModulePath =
	"../.github/scripts/firmware-submission/mirror-pr-checks.mts";
const resetOnEditModulePath =
	"../.github/scripts/firmware-submission/reset-on-edit.mts";
const cleanupLabelsModulePath =
	"../.github/scripts/firmware-submission/cleanup-labels.mts";

const processSubmissionModule = await import(processSubmissionModulePath);
const mirrorPrChecksModule = await import(mirrorPrChecksModulePath);
const resetOnEditModule = await import(resetOnEditModulePath);
const cleanupLabelsModule = await import(cleanupLabelsModulePath);

const {
	appendUpgradesToFirmwareConfigText,
	createUpgradeEntry,
	extractIssueTemplateFieldHeadings,
	findDuplicateTargets,
	findDuplicateUpgradeVariants,
	formatWithPrettier,
	getApprovalInvalidReason,
	parseIssueBody,
	parseUpgradeFilesFromSections,
	sameExactDeviceSet,
} = processSubmissionModule;
const { workflowRunPassed } = mirrorPrChecksModule;
const resetOnEdit = resetOnEditModule.default;
const cleanupLabels = cleanupLabelsModule.default;

type Device = {
	brand: string;
	model: string;
	manufacturerId: string;
	productType: string;
	productId: string;
	firmwareVersion: {
		min: string;
		max: string;
	};
};

function createDevice(overrides: Partial<Device> = {}): Device {
	return {
		brand: "Zooz",
		model: "ZEN51",
		manufacturerId: "0x027a",
		productType: "0x7000",
		productId: "0xa008",
		firmwareVersion: {
			min: "0.0",
			max: "255.255",
		},
		...overrides,
	};
}

function getDeviceFieldLabel(name: string, index: number): string {
	return index === 1 ? name : `${name} (Device ${index})`;
}

function getUpgradeFieldLabel(name: string, index: number): string {
	return index === 1 ? name : `${name} (Upgrade ${index})`;
}

function getSingleTargetUrlFieldLabel(index: number): string {
	return index === 1 ? "Firmware URL" : `Firmware URL (Upgrade ${index})`;
}

function getSingleTargetTargetNumberFieldLabel(index: number): string {
	return index === 1 ? "Target Number" : `Target Number (Upgrade ${index})`;
}

function createSingleTargetIssueBody({
	deviceCount,
	upgradeCount,
	targetNumber = null,
}: {
	deviceCount: number;
	upgradeCount: number;
	targetNumber?: number | null;
}): string {
	const lines: string[] = [];

	for (let deviceIndex = 1; deviceIndex <= deviceCount; deviceIndex++) {
		lines.push(
			`### ${getDeviceFieldLabel("Brand", deviceIndex)}`,
			"",
			`Brand ${deviceIndex}`,
			`### ${getDeviceFieldLabel("Model", deviceIndex)}`,
			"",
			`Model ${deviceIndex}`,
			`### ${getDeviceFieldLabel("Manufacturer ID", deviceIndex)}`,
			"",
			`0x00${deviceIndex}d`,
			`### ${getDeviceFieldLabel("Product Type", deviceIndex)}`,
			"",
			`0x10${deviceIndex}0`,
			`### ${getDeviceFieldLabel("Product ID", deviceIndex)}`,
			"",
			`0x20${deviceIndex}0`,
			`### ${getDeviceFieldLabel("Firmware Version (Min)", deviceIndex)}`,
			"",
			"_No response_",
			`### ${getDeviceFieldLabel("Firmware Version (Max)", deviceIndex)}`,
			"",
			"_No response_",
		);
	}

	for (let upgradeIndex = 1; upgradeIndex <= upgradeCount; upgradeIndex++) {
		lines.push(
			`### ${getUpgradeFieldLabel("Firmware Version", upgradeIndex)}`,
			"",
			`1.${upgradeIndex}`,
			`### ${getUpgradeFieldLabel("Changelog", upgradeIndex)}`,
			"",
			"### Fixed",
			"",
			`* Change ${upgradeIndex}`,
			`### ${getUpgradeFieldLabel("Channel", upgradeIndex)}`,
			"",
			"stable",
			`### ${getUpgradeFieldLabel("Region", upgradeIndex)}`,
			"",
			"All regions",
			`### ${getUpgradeFieldLabel("Upgrade conditions", upgradeIndex)}`,
			"",
			"_No response_",
		);
		if (targetNumber != null) {
			// Simulate an invalid submission where the user tries to set a target number in the single-target form.
			lines.push(
				`### ${getSingleTargetTargetNumberFieldLabel(upgradeIndex)}`,
				"",
				`${targetNumber}`,
			);
		}
		lines.push(
			`### ${getSingleTargetUrlFieldLabel(upgradeIndex)}`,
			"",
			`https://example.com/fw-${upgradeIndex}.gbl`,
		);
	}

	return lines.join("\n");
}

function createIssuesMock(labels: string[] = []) {
	const removeLabelCalls: string[] = [];
	const addLabelsCalls: string[][] = [];
	const issues = {
		removeLabel: async ({ name }: { name: string }) => {
			removeLabelCalls.push(name);
		},
		addLabels: async ({ labels }: { labels: string[] }) => {
			addLabelsCalls.push(labels);
		},
		get: async () => ({
			data: {
				labels: labels.map((name) => ({ name })),
			},
		}),
	};

	return {
		issues,
		removeLabelCalls,
		addLabelsCalls,
	};
}

test("parseIssueBody supports multiple-target issue bodies and preserves markdown headings inside textarea fields", (t) => {
	const body = `
### Brand

Zooz
### Model

ZEN51
### Manufacturer ID

0x027a
### Product Type

0x7000
### Product ID

0xa008
### Firmware Version (Min)

_No response_
### Firmware Version (Max)

_No response_
### Brand (Device 2)

_No response_
### Model (Device 2)

_No response_
### Manufacturer ID (Device 2)

_No response_
### Product Type (Device 2)

_No response_
### Product ID (Device 2)

_No response_
### Firmware Version (Min) (Device 2)

_No response_
### Firmware Version (Max) (Device 2)

_No response_
### Brand (Device 3)

_No response_
### Model (Device 3)

_No response_
### Manufacturer ID (Device 3)

_No response_
### Product Type (Device 3)

_No response_
### Product ID (Device 3)

_No response_
### Firmware Version (Min) (Device 3)

_No response_
### Firmware Version (Max) (Device 3)

_No response_
### Firmware Version

1.23
### Changelog

### Fixed

* Bug fixes
* Added a feature
### Channel

stable
### Region

All regions
### Upgrade conditions

_No response_
### Target Number (Chip 1)

0
### Firmware URL (Chip 1)

https://example.com/fw-0.gbl
### Target Number (Chip 2)

1
### Firmware URL (Chip 2)

_No response_
### Target Number (Chip 3)

2
### Firmware URL (Chip 3)

_No response_
`.trim();

	const sections = parseIssueBody(body) as Record<string, string | null>;

	t.is(sections.Changelog, "### Fixed\n\n* Bug fixes\n* Added a feature");
	t.is(sections.Channel, "stable");
	t.is(sections["Target Number (Chip 1)"], "0");
	t.is(sections["Firmware URL (Chip 1)"], "https://example.com/fw-0.gbl");
});

test("parseIssueBody supports single-target issue bodies with single and multiple devices and upgrades", (t) => {
	const scenarios = [
		{
			deviceCount: 2,
			upgradeCount: 2,
			urlLabel: "Firmware URL (Upgrade 2)",
		},
		{ deviceCount: 2, upgradeCount: 1, urlLabel: "Firmware URL" },
		{
			deviceCount: 1,
			upgradeCount: 2,
			urlLabel: "Firmware URL (Upgrade 2)",
		},
		{ deviceCount: 1, upgradeCount: 1, urlLabel: "Firmware URL" },
	];

	for (const scenario of scenarios) {
		const sections = parseIssueBody(
			createSingleTargetIssueBody({
				deviceCount: scenario.deviceCount,
				upgradeCount: scenario.upgradeCount,
			}),
		) as Record<string, string | null>;

		t.is(sections.Brand, "Brand 1");
		t.is(
			sections[getDeviceFieldLabel("Brand", scenario.deviceCount)],
			`Brand ${scenario.deviceCount}`,
		);
		t.is(
			sections[scenario.urlLabel],
			`https://example.com/fw-${scenario.upgradeCount}.gbl`,
		);
		t.is(
			sections[getUpgradeFieldLabel("Changelog", scenario.upgradeCount)],
			`### Fixed\n\n* Change ${scenario.upgradeCount}`,
		);
	}
});

test("extractIssueTemplateFieldHeadings tolerates YAML indentation changes", (t) => {
	const headings = extractIssueTemplateFieldHeadings(`
attributes:
    label: Brand
  label: "Model"
      label: 'Firmware URL'
`);

	t.deepEqual(headings, ["Brand", "Model", "Firmware URL"]);
});

test("parseIssueBody supports single-target issue bodies with explicit target-number fields", (t) => {
	const sections = parseIssueBody(
		createSingleTargetIssueBody({
			deviceCount: 1,
			upgradeCount: 2,
			targetNumber: 2,
		}),
	) as Record<string, string | null>;

	t.is(sections["Target Number"], "2");
	t.is(sections["Target Number (Upgrade 2)"], "2");
	t.is(sections["Firmware URL (Upgrade 2)"], "https://example.com/fw-2.gbl");
});

test("sameExactDeviceSet only matches identical normalized device sets", (t) => {
	const deviceA = createDevice();
	const deviceB = createDevice({
		model: "ZEN52",
		productType: "0x7001",
		productId: "0xa009",
	});

	t.true(sameExactDeviceSet([deviceA, deviceB], [deviceB, deviceA]));
	t.false(sameExactDeviceSet([deviceA, deviceB], [deviceA]));
	t.false(
		sameExactDeviceSet(
			[deviceA, deviceB],
			[
				deviceA,
				createDevice({
					model: "ZEN52",
					productType: "0x7001",
					productId: "0xa009",
					firmwareVersion: {
						min: "1.0",
						max: "255.255",
					},
				}),
			],
		),
	);
});

test("getApprovalInvalidReason rejects body or label changes after approval", (t) => {
	t.is(
		getApprovalInvalidReason({
			approvedBody: "approved body",
			currentBody: "approved body",
			labelNames: ["approved", "processing"],
			requireProcessing: true,
		}),
		null,
	);
	t.is(
		getApprovalInvalidReason({
			approvedBody: "approved body",
			currentBody: "edited body",
			labelNames: ["approved", "processing"],
			requireProcessing: true,
		}),
		"Submission body no longer matches the approved snapshot.",
	);
	t.is(
		getApprovalInvalidReason({
			approvedBody: "approved body",
			currentBody: "approved body",
			labelNames: ["pending-approval"],
		}),
		"Submission is no longer approved.",
	);
	t.is(
		getApprovalInvalidReason({
			approvedBody: "approved body",
			currentBody: "approved body",
			labelNames: ["approved", "pending-approval"],
		}),
		null,
	);
});

test("reset-on-edit ignores non-body edits", async (t) => {
	const { issues, removeLabelCalls, addLabelsCalls } = createIssuesMock();

	await resetOnEdit({
		github: {
			rest: {
				issues,
			},
		} as any,
		context: {
			repo: {
				owner: "zwave-js",
				repo: "firmware-updates",
			},
			payload: {
				issue: {
					number: 123,
				},
				changes: {
					title: {
						from: "Old title",
					},
				},
			},
		} as any,
	});

	t.deepEqual(removeLabelCalls, []);
	t.deepEqual(addLabelsCalls, []);
});

test("cleanup-labels restores pending-approval on unmerged submission PR close", async (t) => {
	const { issues, removeLabelCalls, addLabelsCalls } = createIssuesMock([
		"approved",
		"submitted",
	]);

	await cleanupLabels({
		github: {
			rest: {
				issues,
			},
		} as any,
		context: {
			repo: {
				owner: "zwave-js",
				repo: "firmware-updates",
			},
			payload: {
				pull_request: {
					head: {
						repo: {
							full_name: "zwave-js/firmware-updates",
						},
						ref: "firmware-submission/issue-123",
					},
					user: {
						login: "zwave-js-bot",
					},
					merged: false,
					body: "Closes #123\n\n<!-- Auto-generated from issue #123. -->",
				},
			},
		} as any,
	});

	t.deepEqual(removeLabelCalls, ["approved", "submitted"]);
	t.deepEqual(addLabelsCalls, [["pending-approval"]]);
});

test("cleanup-labels does not restore pending-approval for merged submission PR close", async (t) => {
	const { issues, removeLabelCalls, addLabelsCalls } = createIssuesMock([
		"approved",
		"submitted",
	]);

	await cleanupLabels({
		github: {
			rest: {
				issues,
			},
		} as any,
		context: {
			repo: {
				owner: "zwave-js",
				repo: "firmware-updates",
			},
			payload: {
				pull_request: {
					head: {
						repo: {
							full_name: "zwave-js/firmware-updates",
						},
						ref: "firmware-submission/issue-123",
					},
					user: {
						login: "zwave-js-bot",
					},
					merged: true,
					body: "Closes #123\n\n<!-- Auto-generated from issue #123. -->",
				},
			},
		} as any,
	});

	t.deepEqual(removeLabelCalls, ["approved", "submitted"]);
	t.deepEqual(addLabelsCalls, []);
});

test("auto-approve workflow only resets on issue body edits", async (t) => {
	const workflow = await readFile(
		new URL(
			"../.github/workflows/auto-approve-firmware-submission.yml",
			import.meta.url,
		),
		"utf8",
	);

	t.regex(
		workflow,
		/reset-on-edit:[\s\S]*github\.event\.changes\.body != null/,
	);
});

test("cleanup workflow uses GITHUB_TOKEN so pending-approval restore does not auto-trigger reapproval", async (t) => {
	const workflow = await readFile(
		new URL(
			"../.github/workflows/cleanup-firmware-submission-labels.yml",
			import.meta.url,
		),
		"utf8",
	);

	t.regex(workflow, /github-token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test("findDuplicateUpgradeVariants allows region variants but blocks exact and cross-channel duplicates", (t) => {
	t.deepEqual(
		findDuplicateUpgradeVariants(
			[{ version: "12.23", region: "europe" }],
			[{ version: "12.23", region: "usa" }],
		),
		[],
	);
	t.deepEqual(
		findDuplicateUpgradeVariants(
			[{ version: "12.23", channel: "stable" }],
			[{ version: "12.23" }],
		),
		["v12.23"],
	);
	t.deepEqual(
		findDuplicateUpgradeVariants(
			[],
			[
				{ version: "12.23", region: "europe" },
				{ version: "12.23", region: "europe" },
			],
		),
		["v12.23, region europe"],
	);
	t.deepEqual(
		findDuplicateUpgradeVariants(
			[{ version: "12.23", channel: "stable", region: "europe" }],
			[{ version: "12.23", channel: "beta", region: "europe" }],
		),
		["v12.23, channel beta, region europe"],
	);
});

test("findDuplicateTargets reports repeated target numbers within one upgrade", (t) => {
	t.deepEqual(
		findDuplicateTargets([{ target: 1 }, { target: 0 }, { target: 1 }]),
		[1],
	);
	t.deepEqual(
		findDuplicateTargets([{ target: 2 }, { target: 1 }, { target: 0 }]),
		[],
	);
});

test("parseUpgradeFilesFromSections keeps each chip row paired with its selected target", (t) => {
	const files = parseUpgradeFilesFromSections({
		sections: {
			"Firmware URL (Chip 1) (Upgrade 3)":
				"https://example.com/chip-1.gbl",
			"Target Number (Chip 1) (Upgrade 3)": "2",
			"Firmware URL (Chip 2) (Upgrade 3)":
				"https://example.com/chip-2.gbl",
			"Target Number (Chip 2) (Upgrade 3)": "0",
			"Firmware URL (Chip 3) (Upgrade 3)": null,
			"Target Number (Chip 3) (Upgrade 3)": "1",
		},
		upgradeIndex: 3,
		errors: [],
	});

	t.deepEqual(files, [
		{ target: 2, url: "https://example.com/chip-1.gbl" },
		{ target: 0, url: "https://example.com/chip-2.gbl" },
	]);
});

test("parseUpgradeFilesFromSections defaults single-target upgrades to target 0", (t) => {
	const files = parseUpgradeFilesFromSections({
		sections: {
			"Firmware URL (Upgrade 2)": "https://example.com/fw-2.gbl",
		},
		upgradeIndex: 2,
		errors: [],
	});

	t.deepEqual(files, [{ target: 0, url: "https://example.com/fw-2.gbl" }]);
});

test("parseUpgradeFilesFromSections rejects explicit target numbers in single-target issue bodies", (t) => {
	const errors: string[] = [];
	const files = parseUpgradeFilesFromSections({
		sections: {
			"Target Number (Upgrade 2)": "2",
			"Firmware URL (Upgrade 2)": "https://example.com/fw-2.gbl",
		},
		upgradeIndex: 2,
		errors,
	});

	t.deepEqual(files, [{ target: 0, url: "https://example.com/fw-2.gbl" }]);
	t.deepEqual(errors, [
		"'Target Number (Upgrade 2)' is not supported in the single-target submission form. That form always uses target number 0. Use the 'Firmware Submission' form instead.",
	]);
});

test("parseUpgradeFilesFromSections accepts chip 1 labels without explicit target selection", (t) => {
	const files = parseUpgradeFilesFromSections({
		sections: {
			"Firmware URL (Chip 1) (Upgrade 3)":
				"https://example.com/fw-chip-1.gbl",
		},
		upgradeIndex: 3,
		errors: [],
	});

	t.deepEqual(files, [
		{ target: 0, url: "https://example.com/fw-chip-1.gbl" },
	]);
});

test("createUpgradeEntry preserves submitted file order and targets", (t) => {
	const entry = createUpgradeEntry({
		version: "1.61",
		changelog: "Test changelog",
		channel: "beta",
		region: null,
		ifCondition: null,
		files: [
			{
				target: 1,
				url: "https://example.com/target-1.gbl",
				integrity:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			},
			{
				target: 0,
				url: "https://example.com/target-0.gbl",
				integrity:
					"sha256:0000000000000000000000000000000000000000000000000000000000000000",
			},
		],
	}) as { files?: Array<{ target: number; url: string }> };

	t.deepEqual(
		entry.files?.map(({ target, url }) => ({ target, url })),
		[
			{ target: 1, url: "https://example.com/target-1.gbl" },
			{ target: 0, url: "https://example.com/target-0.gbl" },
		],
	);
});

test("appendUpgradesToFirmwareConfigText preserves existing JSONC comments after formatting", async (t) => {
	const existingConfig = `{
	"devices": [
		{
			"brand": "Zooz",
			"model": "ZEN51", // existing model comment
			"manufacturerId": "0x027a",
			"productType": "0x7000",
			"productId": "0xa008"
		}
	],
	"upgrades": [
		// existing upgrade comment
		{
			"version": "1.60",
			"changelog": "Existing release",
			"url": "https://example.com/existing.gbl",
			"integrity": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		}
	]
}
`;

	const updatedConfig = await formatWithPrettier(
		appendUpgradesToFirmwareConfigText(existingConfig, [
			createUpgradeEntry({
				version: "1.61",
				changelog: "New release",
				channel: "stable",
				region: null,
				ifCondition: null,
				files: [
					{
						target: 0,
						url: "https://example.com/new.gbl",
						integrity:
							"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					},
				],
			}),
			]),
		"jsonc",
		{
			endOfLine: "lf",
			tabWidth: 4,
			useTabs: true,
		},
	);

	t.true(updatedConfig.includes("// existing model comment"));
	t.true(updatedConfig.includes("// existing upgrade comment"));
	t.true(updatedConfig.includes('\t"devices": ['));

	const parsed: {
		upgrades: Array<{ version: string }>;
	} = JSON5.parse(updatedConfig);
	t.deepEqual(
		parsed.upgrades.map((upgrade) => upgrade.version),
		["1.60", "1.61"],
	);
});

test("createUpgradeEntry uses top-level url and integrity for a single target 0 file", (t) => {
	const entry = createUpgradeEntry({
		version: "1.61",
		changelog: "Test changelog",
		channel: "stable",
		region: null,
		ifCondition: null,
		files: [
			{
				target: 0,
				url: "https://example.com/target-0.gbl",
				integrity:
					"sha256:0000000000000000000000000000000000000000000000000000000000000000",
			},
		],
	}) as {
		url?: string;
		integrity?: string;
		files?: Array<{ target: number; url: string }>;
	};

	t.is(entry.url, "https://example.com/target-0.gbl");
	t.truthy(entry.integrity);
	t.is(entry.files, undefined);
});

test("createUpgradeEntry keeps files for a single non-zero target file", (t) => {
	const entry = createUpgradeEntry({
		version: "1.61",
		changelog: "Test changelog",
		channel: "stable",
		region: null,
		ifCondition: null,
		files: [
			{
				target: 2,
				url: "https://example.com/target-2.gbl",
				integrity:
					"sha256:2222222222222222222222222222222222222222222222222222222222222222",
			},
		],
	}) as {
		url?: string;
		integrity?: string;
		files?: Array<{ target: number; url: string; integrity: string }>;
	};

	t.is(entry.url, undefined);
	t.is(entry.integrity, undefined);
	t.deepEqual(entry.files, [
		{
			target: 2,
			url: "https://example.com/target-2.gbl",
			integrity:
				"sha256:2222222222222222222222222222222222222222222222222222222222222222",
		},
	]);
});

test("workflowRunPassed only treats successful conclusions as passing", (t) => {
	t.true(workflowRunPassed("success"));
	t.false(workflowRunPassed("cancelled"));
	t.false(workflowRunPassed("timed_out"));
	t.false(workflowRunPassed(null));
});
