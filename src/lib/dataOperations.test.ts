import test from "ava";
import type { DataManifest, DataShard } from "./dataFormat.js";
import {
	getDataVersion,
	lookupConfig,
	lookupConfigsBatch,
} from "./dataOperations.js";
import { versionToNumber } from "./shared.js";

function mockAssets(manifest: DataManifest, shards: Record<string, DataShard>) {
	return {
		fetch: (input: any) => {
			const path = new URL(
				typeof input === "string" ? input : input.url,
			).pathname;
			let body: unknown;
			if (path === "/manifest.json") {
				body = manifest;
			} else {
				const match = /^\/shards\/(.+)\.json$/.exec(path);
				if (match) body = shards[match[1]];
			}
			if (body === undefined) {
				return Promise.resolve(new Response(null, { status: 404 }));
			}
			return Promise.resolve(
				new Response(JSON.stringify(body), { status: 200 }),
			);
		},
	} as any;
}

const upgrade1 = {
	version: "1.5",
	changelog: "Fixed stuff",
	channel: "stable" as const,
	files: [
		{
			target: 0,
			url: "https://example.com/1.5.otz",
			integrity: "sha256:" + "0".repeat(64),
		},
	],
};

const upgrade2 = {
	$if: "firmwareVersion < 1.0",
	version: "1.0",
	changelog: "Initial",
	channel: "stable" as const,
	files: [
		{
			target: 0,
			url: "https://example.com/1.0.otz",
			integrity: "sha256:" + "1".repeat(64),
		},
	],
};

const defaultManifest: DataManifest = {
	version: "abcd1234",
	shards: ["0x0086"],
};

const defaultShards: Record<string, DataShard> = {
	"0x0086": {
		configs: [
			{
				devices: [
					{
						productType: "0x0002",
						productId: "0x0064",
						min: versionToNumber("0.0.0"),
						max: versionToNumber("255.255.255"),
					},
				],
				upgrades: [upgrade1, upgrade2],
			},
		],
	},
};

test("getDataVersion returns the manifest version", async (t) => {
	const assets = mockAssets(defaultManifest, defaultShards);
	t.is(await getDataVersion(assets), "abcd1234");
});

test("lookupConfig returns updates for a known device", async (t) => {
	const assets = mockAssets(defaultManifest, defaultShards);
	const result = await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "1.5");

	t.truthy(result);
	t.is(result!.manufacturerId, "0x0086");
	t.is(result!.firmwareVersion, "1.5.0");
	// The $if condition of upgrade2 does not apply for version 1.5
	t.is(result!.updates.length, 1);
	t.is(result!.updates[0].version, "1.5");
});

test("lookupConfig evaluates $if conditions against the device", async (t) => {
	const assets = mockAssets(defaultManifest, defaultShards);
	const result = await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "0.5");

	t.truthy(result);
	t.deepEqual(
		result!.updates.map((u) => u.version),
		["1.5", "1.0"],
	);
});

test("lookupConfig respects the device firmware version range", async (t) => {
	const shards: Record<string, DataShard> = {
		"0x0086": {
			configs: [
				{
					devices: [
						{
							productType: "0x0002",
							productId: "0x0064",
							min: versionToNumber("1.0.0"),
							max: versionToNumber("1.255.255"),
						},
					],
					upgrades: [upgrade1],
				},
			],
		},
	};
	const assets = mockAssets(defaultManifest, shards);

	t.truthy(await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "1.5"));
	t.is(
		await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "2.0"),
		undefined,
	);
	t.is(
		await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "0.9"),
		undefined,
	);
});

test("lookupConfig merges updates from multiple matching configs", async (t) => {
	const shards: Record<string, DataShard> = {
		"0x0086": {
			configs: [
				{
					devices: [
						{
							productType: "0x0002",
							productId: "0x0064",
							min: 0,
							max: versionToNumber("255.255.255"),
						},
					],
					upgrades: [upgrade1],
				},
				{
					devices: [
						{
							productType: "0x0002",
							productId: "0x0064",
							min: 0,
							max: versionToNumber("255.255.255"),
						},
					],
					upgrades: [upgrade2],
				},
			],
		},
	};
	const assets = mockAssets(defaultManifest, shards);
	const result = await lookupConfig(assets, "0x0086", "0x0002", "0x0064", "0.5");

	t.deepEqual(
		result!.updates.map((u) => u.version),
		["1.5", "1.0"],
	);
});

test("lookupConfigsBatch skips unknown devices", async (t) => {
	const assets = mockAssets(defaultManifest, defaultShards);
	const results = await lookupConfigsBatch(assets, [
		// Unknown manufacturer (no shard)
		{
			manufacturerId: "0x9999",
			productType: "0x0002",
			productId: "0x0064",
			firmwareVersion: "1.0",
		},
		// Known manufacturer, unknown product
		{
			manufacturerId: "0x0086",
			productType: "0xffff",
			productId: "0x0064",
			firmwareVersion: "1.0",
		},
		// Known device
		{
			manufacturerId: "0x0086",
			productType: "0x0002",
			productId: "0x0064",
			firmwareVersion: "1.0",
		},
	]);

	t.is(results.length, 1);
	t.is(results[0].productType, "0x0002");
});
