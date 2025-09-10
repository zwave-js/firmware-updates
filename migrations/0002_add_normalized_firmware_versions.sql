-- Add normalized firmware version columns for efficient comparison

-- Step 1: Add new columns as optional
ALTER TABLE devices ADD COLUMN firmware_version_min_normalized INTEGER;
ALTER TABLE devices ADD COLUMN firmware_version_max_normalized INTEGER;

-- Step 2: Populate the normalized columns from existing version strings
-- Handle both x.y and x.y.z formats by padding with .0 as needed
UPDATE devices SET 
    firmware_version_min_normalized = (
        CAST(SUBSTR(firmware_version_min || '.0.0', 1, INSTR(firmware_version_min || '.0.0', '.') - 1) AS INTEGER) * 65536 +
        CAST(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1, 
             CASE WHEN INSTR(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1), '.') > 0 
                  THEN INSTR(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1), '.') - 1 
                  ELSE LENGTH(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1)) END) AS INTEGER) * 256 +
        CAST(CASE WHEN INSTR(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1), '.') > 0 
                  THEN SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + INSTR(SUBSTR(firmware_version_min || '.0.0', INSTR(firmware_version_min || '.0.0', '.') + 1), '.') + 1)
                  ELSE '0' END AS INTEGER)
    ),
    firmware_version_max_normalized = (
        CAST(SUBSTR(firmware_version_max || '.0.0', 1, INSTR(firmware_version_max || '.0.0', '.') - 1) AS INTEGER) * 65536 +
        CAST(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1, 
             CASE WHEN INSTR(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1), '.') > 0 
                  THEN INSTR(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1), '.') - 1 
                  ELSE LENGTH(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1)) END) AS INTEGER) * 256 +
        CAST(CASE WHEN INSTR(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1), '.') > 0 
                  THEN SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + INSTR(SUBSTR(firmware_version_max || '.0.0', INSTR(firmware_version_max || '.0.0', '.') + 1), '.') + 1)
                  ELSE '0' END AS INTEGER)
    );

-- Step 3: Create a new table with the required constraints and copy data
CREATE TABLE devices_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    manufacturer_id TEXT NOT NULL,
    product_type TEXT NOT NULL,
    product_id TEXT NOT NULL,
    firmware_version_min TEXT NOT NULL DEFAULT '0.0',
    firmware_version_max TEXT NOT NULL DEFAULT '255.255',
    firmware_version_min_normalized INTEGER NOT NULL,
    firmware_version_max_normalized INTEGER NOT NULL,
    FOREIGN KEY (version) REFERENCES config_versions(version) ON DELETE CASCADE
);

-- Copy data from old table
INSERT INTO devices_new (
    id, version, brand, model, manufacturer_id, product_type, product_id,
    firmware_version_min, firmware_version_max, 
    firmware_version_min_normalized, firmware_version_max_normalized
)
SELECT 
    id, version, brand, model, manufacturer_id, product_type, product_id,
    firmware_version_min, firmware_version_max,
    firmware_version_min_normalized, firmware_version_max_normalized
FROM devices;

-- Drop the old table and rename the new one
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

-- Recreate the index for the devices table
CREATE INDEX IF NOT EXISTS idx_devices_lookup ON devices(version, manufacturer_id, product_type, product_id);

-- Create an index on the normalized version columns for efficient range queries
CREATE INDEX IF NOT EXISTS idx_devices_firmware_versions ON devices(firmware_version_min_normalized, firmware_version_max_normalized);
