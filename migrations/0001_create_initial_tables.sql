-- Create the main tables for firmware update definitions

-- Track configuration versions
CREATE TABLE IF NOT EXISTS config_versions (
    version TEXT PRIMARY KEY,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Devices table - stores device information from the JSON configs
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    product_type TEXT NOT NULL,
    product_id TEXT NOT NULL,
    firmware_version_min TEXT NOT NULL DEFAULT '0.0',
    firmware_version_max TEXT NOT NULL DEFAULT '255.255',
    FOREIGN KEY (version) REFERENCES config_versions(version) ON DELETE CASCADE
);

-- Upgrades table - stores upgrade information
CREATE TABLE IF NOT EXISTS upgrades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    version TEXT NOT NULL, -- config version, not firmware version
    firmware_version TEXT NOT NULL, -- target firmware version
    changelog TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    region TEXT,
    condition TEXT, -- the $if condition
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (version) REFERENCES config_versions(version) ON DELETE CASCADE
);

-- Upgrade files table - stores file information for each upgrade
CREATE TABLE IF NOT EXISTS upgrade_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upgrade_id INTEGER NOT NULL,
    target INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    integrity TEXT NOT NULL,
    FOREIGN KEY (upgrade_id) REFERENCES upgrades(id) ON DELETE CASCADE
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_devices_lookup ON devices(version, manufacturer_id, product_type, product_id);
CREATE INDEX IF NOT EXISTS idx_devices_firmware_version ON devices(firmware_version_min, firmware_version_max);
CREATE INDEX IF NOT EXISTS idx_upgrades_device ON upgrades(device_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_files_upgrade ON upgrade_files(upgrade_id);
CREATE INDEX IF NOT EXISTS idx_config_versions_active ON config_versions(active) WHERE active = TRUE;