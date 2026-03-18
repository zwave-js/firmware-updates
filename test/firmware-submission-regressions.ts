import test from "ava";
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
	createUpgradeEntry,
	findDuplicateTargets,
	findDuplicateUpgradeVariants,
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

test("parseIssueBody preserves markdown headings inside textarea fields", (t) => {
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
		new URL("../.github/workflows/auto-approve-firmware-submission.yml", import.meta.url),
		"utf8",
	);

	t.regex(workflow, /reset-on-edit:[\s\S]*github\.event\.changes\.body != null/);
});

test("cleanup workflow uses GITHUB_TOKEN so pending-approval restore does not auto-trigger reapproval", async (t) => {
	const workflow = await readFile(
		new URL("../.github/workflows/cleanup-firmware-submission-labels.yml", import.meta.url),
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

test("workflowRunPassed only treats successful conclusions as passing", (t) => {
	t.true(workflowRunPassed("success"));
	t.false(workflowRunPassed("cancelled"));
	t.false(workflowRunPassed("timed_out"));
	t.false(workflowRunPassed(null));
});
