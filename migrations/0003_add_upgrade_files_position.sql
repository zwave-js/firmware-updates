-- Preserve the original order of files within an upgrade.
-- Multi-chip updates depend on execution order (e.g. target 1 before target 0).

ALTER TABLE upgrade_files ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: assign sequential positions per upgrade based on id order
UPDATE upgrade_files SET position = (
    SELECT COUNT(*)
    FROM upgrade_files AS uf2
    WHERE uf2.upgrade_id = upgrade_files.upgrade_id
    AND uf2.id <= upgrade_files.id
) - 1;
