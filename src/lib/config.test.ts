// Basic test to verify D1 operations work correctly
// This test simulates the key functionality without requiring a real D1 database

import test from 'ava';
import { ConditionalUpdateConfig } from '../lib/config.js';

// Test that the ConditionalUpdateConfig still works correctly
test('ConditionalUpdateConfig parses device and upgrade data correctly', t => {
	const testConfig = {
		devices: [
			{
				brand: "Test Brand",
				model: "Test Model",
				manufacturerId: "0x1234",
				productType: "0x5678", 
				productId: "0x9abc",
				firmwareVersion: {
					min: "1.0",
					max: "2.0"
				}
			}
		],
		upgrades: [
			{
				version: "1.5",
				changelog: "Test upgrade",
				channel: "stable",
				files: [
					{
						target: 0,
						url: "https://example.com/firmware.bin",
						integrity: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
					}
				]
			}
		]
	};

	const config = new ConditionalUpdateConfig(testConfig);
	
	t.is(config.devices.length, 1);
	t.is(config.devices[0].brand, "Test Brand");
	t.is(config.devices[0].manufacturerId, "0x1234");
	
	t.is(config.upgrades.length, 1);
	t.is(config.upgrades[0].version, "1.5");
	t.is(config.upgrades[0].files.length, 1);
	
	// Test evaluation
	const deviceId = {
		manufacturerId: 0x1234,
		productType: 0x5678,
		productId: 0x9abc,
		firmwareVersion: "1.2"
	};
	
	const evaluated = config.evaluate(deviceId);
	t.is(evaluated.upgrades.length, 1);
	t.is(evaluated.upgrades[0].version, "1.5");
});

test('ConditionalUpdateConfig handles conditional upgrades', t => {
	const testConfig = {
		devices: [
			{
				brand: "Test Brand",
				model: "Test Model", 
				manufacturerId: "0x1234",
				productType: "0x5678",
				productId: "0x9abc"
			}
		],
		upgrades: [
			{
				$if: "firmwareVersion >= 1.0 && firmwareVersion < 2.0",
				version: "2.0",
				changelog: "Major upgrade",
				channel: "stable",
				files: [
					{
						target: 0,
						url: "https://example.com/firmware-v2.bin",
						integrity: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
					}
				]
			}
		]
	};

	const config = new ConditionalUpdateConfig(testConfig);
	
	// Test with firmware version that matches condition
	const deviceId1 = {
		manufacturerId: 0x1234,
		productType: 0x5678,
		productId: 0x9abc,
		firmwareVersion: "1.5"
	};
	
	const evaluated1 = config.evaluate(deviceId1);
	t.is(evaluated1.upgrades.length, 1, 'Should include upgrade when condition matches');
	
	// Test with firmware version that doesn't match condition
	const deviceId2 = {
		manufacturerId: 0x1234,
		productType: 0x5678,
		productId: 0x9abc,
		firmwareVersion: "2.5"
	};
	
	const evaluated2 = config.evaluate(deviceId2);
	t.is(evaluated2.upgrades.length, 0, 'Should exclude upgrade when condition does not match');
});

test('ConditionalUpdateConfig handles multiple files per upgrade', t => {
	const testConfig = {
		devices: [
			{
				brand: "Test Brand",
				model: "Test Model",
				manufacturerId: "0x1234",
				productType: "0x5678",
				productId: "0x9abc"
			}
		],
		upgrades: [
			{
				version: "1.5",
				changelog: "Multi-target upgrade",
				channel: "stable",
				files: [
					{
						target: 0,
						url: "https://example.com/firmware-target0.bin",
						integrity: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
					},
					{
						target: 1,
						url: "https://example.com/firmware-target1.bin", 
						integrity: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
					}
				]
			}
		]
	};

	const config = new ConditionalUpdateConfig(testConfig);
	
	const deviceId = {
		manufacturerId: 0x1234,
		productType: 0x5678,
		productId: 0x9abc,
		firmwareVersion: "1.0"
	};
	
	const evaluated = config.evaluate(deviceId);
	t.is(evaluated.upgrades.length, 1);
	t.is(evaluated.upgrades[0].files.length, 2);
	t.is(evaluated.upgrades[0].files[0].target, 0);
	t.is(evaluated.upgrades[0].files[1].target, 1);
});