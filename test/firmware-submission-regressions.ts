import test from "ava";

const processSubmissionModulePath =
	"../.github/scripts/firmware-submission/process-submission.mts";
const mirrorPrChecksModulePath =
	"../.github/scripts/firmware-submission/mirror-pr-checks.mts";

const processSubmissionModule = await import(processSubmissionModulePath);
const mirrorPrChecksModule = await import(mirrorPrChecksModulePath);

const { getApprovalInvalidReason, parseIssueBody, sameExactDeviceSet } =
	processSubmissionModule;
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
`.trim();

	const sections = parseIssueBody(body) as Record<string, string | null>;

	t.is(sections.Changelog, "### Fixed\n\n* Bug fixes\n* Added a feature");
	t.is(sections.Channel, "stable");
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
		"Submission was reset to pending approval.",
	);
});

test("workflowRunPassed only treats successful conclusions as passing", (t) => {
	t.true(workflowRunPassed("success"));
	t.false(workflowRunPassed("cancelled"));
	t.false(workflowRunPassed("timed_out"));
	t.false(workflowRunPassed(null));
});
