import test from "ava";
import { UpdateConfig } from "./config";

test("Parse single config", async (t) => {
	const definition = {
		devices: [
			{
				brand: "Coolio",
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				url: "https://example.com/firmware/1.7.otz",
				integrity:
					"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
			},
		],
	};

	const config = new UpdateConfig(definition);

	t.is(config.devices.length, 1);
	t.is(config.upgrades.length, 1);
	t.is(config.devices[0].brand, "Coolio");
	t.is(config.upgrades[0].files.length, 1);
});

test("Parse single config with missing field in devices", async (t) => {
	const definition = {
		devices: [
			{
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				url: "https://example.com/firmware/1.7.otz",
				integrity:
					"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
			},
		],
	};

	try {
		new UpdateConfig(definition);
		t.fail("Expected error");
	} catch (e: any) {
		const msg = e.issues;
		t.deepEqual(msg, [
			{
				code: "invalid_type",
				expected: "string",
				received: "undefined",
				path: ["devices", 0, "brand"],
				message: "Required",
			},
		]);
	}
});

test("Parse single config with invalid URL", async (t) => {
	const definition = {
		devices: [
			{
				brand: "Coolio",
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				url: "example.com/firmware/1.7.otz",
				integrity:
					"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
			},
		],
	};

	try {
		new UpdateConfig(definition);
		t.fail("Expected error");
	} catch (e: any) {
		const msg = e.issues;
		t.deepEqual(msg, [
			{
				validation: "url",
				code: "invalid_string",
				message: "Invalid url",
				path: ["upgrades", 0, "url"],
			},
		]);
	}
});

test("Parse multi-file config with invalid hash", async (t) => {
	const definition = {
		devices: [
			{
				brand: "Coolio",
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				files: [
					{
						target: 0,
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
					{
						target: 1,
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"foobar:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
				],
			},
		],
	};

	try {
		new UpdateConfig(definition);
		t.fail("Expected error");
	} catch (e: any) {
		const msg = e.issues;
		t.deepEqual(msg, [
			{
				validation: "regex",
				code: "invalid_string",
				message: "Is not a supported hash",
				path: ["upgrades", 0, "files", 1, "integrity"],
			},
		]);
	}
});

test("Parse multi-file config with duplicate target", async (t) => {
	const definition = {
		devices: [
			{
				brand: "Coolio",
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				files: [
					{
						target: 0,
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
					{
						// Oops, accidentally missed the target
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
				],
			},
		],
	};

	t.throws(() => new UpdateConfig(definition), {
		message: "Duplicate target 0 in upgrades[0]",
	});
});

test("Parse multi-file config with duplicate URL", async (t) => {
	const definition = {
		devices: [
			{
				brand: "Coolio",
				model: "Z-Dim 7",

				manufacturerId: "0x1234",
				productType: "0xabcd",
				productId: "0xcafe",

				firmwareVersion: {
					min: "0.0",
					max: "255.255",
				},
			},
		],

		upgrades: [
			{
				$if: "firmwareVersion >= 1.1 && firmwareVersion < 1.7 && productId === 0xcafe",

				version: "1.7",
				changelog: "* Fixed some bugs\n*Added more bugs",

				files: [
					{
						target: 0,
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
					{
						target: 1,
						url: "https://example.com/firmware/1.7.otz",
						integrity:
							"sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
					},
				],
			},
		],
	};

	t.throws(() => new UpdateConfig(definition), {
		message:
			"Duplicate URL https://example.com/firmware/1.7.otz in upgrades[0]",
	});
});
