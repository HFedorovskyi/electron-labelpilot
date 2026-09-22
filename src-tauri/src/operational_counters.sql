-- Install once under a write transaction. Existing rows are counted only
-- on migration, never on each connection open or each printed package.
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS operational_totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_units INTEGER NOT NULL CHECK (total_units >= 0),
    total_boxes INTEGER NOT NULL CHECK (total_boxes >= 0)
);
INSERT INTO operational_totals (id, total_units, total_boxes)
SELECT 1,
    (SELECT COUNT(*) FROM pack WHERE status != 'Deleted'),
    (SELECT COUNT(*) FROM boxes WHERE status != 'Deleted')
WHERE NOT EXISTS (SELECT 1 FROM operational_totals WHERE id = 1);

-- Unlike total_units this serial never decreases on soft-delete. It is allocated
-- in the same IMMEDIATE transaction as the pack row and its delivery outbox job.
CREATE TABLE IF NOT EXISTS operational_sequences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_pack_sequence INTEGER NOT NULL CHECK (last_pack_sequence >= 0)
);
INSERT INTO operational_sequences (id, last_pack_sequence)
SELECT 1, COALESCE((SELECT MAX(sequence_number) FROM pack), 0)
WHERE NOT EXISTS (SELECT 1 FROM operational_sequences WHERE id = 1);
UPDATE operational_sequences
SET last_pack_sequence = MAX(
    last_pack_sequence,
    COALESCE((SELECT MAX(sequence_number) FROM pack), 0)
)
WHERE id = 1;

-- Compatibility for import/telemetry writers that predate the explicit
-- sequence column. AUTOINCREMENT ids are monotonic and never reused.
CREATE TRIGGER IF NOT EXISTS operational_pack_sequence_fallback
AFTER INSERT ON pack WHEN NEW.sequence_number IS NULL
BEGIN
    UPDATE pack SET sequence_number = NEW.id WHERE id = NEW.id;
    UPDATE operational_sequences
    SET last_pack_sequence = MAX(last_pack_sequence, NEW.id)
    WHERE id = 1;
END;

-- Triggers run in the writer's transaction, across every database connection.
-- Soft deletes, restores, hard deletes and rollback keep the same semantics.
CREATE TRIGGER IF NOT EXISTS operational_totals_pack_insert
AFTER INSERT ON pack WHEN NEW.status != 'Deleted'
BEGIN
    UPDATE operational_totals SET total_units = total_units + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS operational_totals_pack_delete
AFTER DELETE ON pack WHEN OLD.status != 'Deleted'
BEGIN
    UPDATE operational_totals SET total_units = total_units - 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS operational_totals_pack_status
AFTER UPDATE OF status ON pack WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE operational_totals
    SET total_units = total_units + (NEW.status != 'Deleted') - (OLD.status != 'Deleted')
    WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS operational_totals_box_insert
AFTER INSERT ON boxes WHEN NEW.status != 'Deleted'
BEGIN
    UPDATE operational_totals SET total_boxes = total_boxes + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS operational_totals_box_delete
AFTER DELETE ON boxes WHEN OLD.status != 'Deleted'
BEGIN
    UPDATE operational_totals SET total_boxes = total_boxes - 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS operational_totals_box_status
AFTER UPDATE OF status ON boxes WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE operational_totals
    SET total_boxes = total_boxes + (NEW.status != 'Deleted') - (OLD.status != 'Deleted')
    WHERE id = 1;
END;
COMMIT;
