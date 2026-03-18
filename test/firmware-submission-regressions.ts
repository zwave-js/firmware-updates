import test from "ava";

const processSubmissionModulePath =
	"../.github/scripts/firmware-submission/process-submission.mts";
const mirrorPrChecksModulePath =
	"../.github/scripts/firmware-submission/mirror-pr-checks.mts";

const processSubmissionModule = await import(processSubmissionModulePath);
const mirrorPrChecksModule = await import(mirrorPrChecksModulePath);

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
