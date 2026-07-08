import test from "ava";
import { versionToNumber } from "../lib/shared.js";
import {
	buildDataShards,
	buildManifest,
	hashConfigFiles,
	isConfigFile,
} from "./dataBuild.js";

const upgrade = {
	version: "1.5",
	changelog: "Fixed stuff",
	url: "https://example.com/1.5.otz",
	integrity: "sha256:" + "0".repeat(64),
};

function configFile(devices: any[], upgrades: any[] = [upgrade]) {
	return JSON.stringify({ devices, upgrades });
}

const device1 = {
	brand: "Test",
	model: "Device 1",
	manufacturerId: "0x0086",
	productType: "0x0002",
	productId: "0x0064",
};

test("isConfigFile applies the discovery filter", (t) => {
	t.true(isConfigFile("vendor/device.json"));
	t.false(isConfigFile("vendor/device.md"));
	t.false(isConfigFile("index.json"));
	t.false(isConfigFile("vendor/_draft.json"));
	t.false(isConfigFile("vendor/templates/base.json"));
});

test("buildDataShards groups devices by manufacturer ID", (t) => {
	const shards = buildDataShards([
		{ filename: "a.json", data: configFile([device1]) },
		{
			filename: "b.json",
			data: configFile([
				{ ...device1, model: "Device 2", productId: "0x0065" },
				{ ...device1, model: "Other vendor", manufacturerId: "0x027a" },
			]),
		},
	]);

	t.deepEqual([...shards.keys()].sort(), ["0x0086", "0x027a"].sort());
	// a.json and b.json each contribute one config entry to 0x0086
	t.is(shards.get("0x0086")!.configs.length, 2);
	// The multi-manufacturer file lands in both shards with the same upgrades
	const otherVendor = shards.get("0x027a")!.configs[0];
	t.is(otherVendor.devices.length, 1);
	t.is(otherVendor.upgrades[0].version, "1.5");
});

test("buildDataShards normalizes firmware version ranges", (t) => {
	const shards = buildDataShards([
		{
			filename: "a.json",
			data: configFile([
				device1,
				{
					...device1,
					productId: "0x0065",
					firmwareVersion: { min: "1.5", max: "2.0" },
				},
			]),
		},
	]);

	const [defaultRange, explicitRange] = shards.get("0x0086")!.configs[0]
		.devices;
	// No range in the config means "all versions"
	t.is(defaultRange.min, 0);
	t.is(defaultRange.max, versionToNumber("255.255.255"));
	// min is padded with .0, max with .255
	t.is(explicitRange.min, versionToNumber("1.5.0"));
	t.is(explicitRange.max, versionToNumber("2.0.255"));
});

test("buildDataShards names the offending file for invalid configs", (t) => {
	const error = t.throws(() =>
		buildDataShards([
			{ filename: "vendor/broken.json", data: "{ not valid" },
		]),
	);
	t.true(error!.message.includes("vendor/broken.json"));
});

test("hashConfigFiles is deterministic and content-sensitive", (t) => {
	const files = [{ filename: "a.json", data: configFile([device1]) }];
	const hash = hashConfigFiles(files);
	t.is(hash, hashConfigFiles([...files.map((f) => ({ ...f }))]));
	t.regex(hash, /^[0-9a-f]{8}$/);
	t.not(
		hash,
		hashConfigFiles([{ filename: "a.json", data: configFile([device1], [
			{ ...upgrade, version: "1.6" },
		]) }]),
	);
});

test("buildManifest sorts shard IDs and carries the version", (t) => {
	const shards = buildDataShards([
		{
			filename: "a.json",
			data: configFile([
				{ ...device1, manufacturerId: "0x027a" },
				{ ...device1, manufacturerId: "0x0086" },
			]),
		},
	]);
	const manifest = buildManifest("abcd1234", shards);
	t.is(manifest.version, "abcd1234");
	t.deepEqual(manifest.shards, ["0x0086", "0x027a"]);
});
