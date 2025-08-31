-- Enable logical replication in PostgreSQL for Debezium CDC
-- Run this script as a superuser (postgres)

-- 1. Check if logical replication is enabled
-- wal_level should be 'logical'
SHOW wal_level;

-- If not logical, you need to set it in postgresql.conf and restart:
-- wal_level = logical
-- max_replication_slots = 4
-- max_wal_senders = 4

-- 2. Create replication slot (if not exists)
SELECT * FROM pg_replication_slots WHERE slot_name = 'debezium_slot';

-- If it doesn't exist, create it:
-- SELECT pg_create_logical_replication_slot('debezium_slot', 'pgoutput');

-- 3. Create signal table for Debezium (optional but recommended)
CREATE SCHEMA IF NOT EXISTS documents;

CREATE TABLE IF NOT EXISTS documents.debezium_signal (
    id VARCHAR(42) PRIMARY KEY,
    type VARCHAR(32) NOT NULL,
    data TEXT NULL
);

-- Grant permissions
GRANT ALL ON SCHEMA documents TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA documents TO postgres;

-- 4. Create publication for all tables in the documents schema
CREATE PUBLICATION dbz_publication FOR ALL TABLES;

-- Or for specific tables:
-- CREATE PUBLICATION dbz_publication FOR TABLE documents.table1, documents.table2;

-- 5. Verify the setup
SELECT * FROM pg_publication;
SELECT * FROM pg_replication_slots;

-- 6. Grant replication permissions to the user
ALTER USER postgres REPLICATION;

-- 7. List tables that will be captured
SELECT schemaname, tablename 
FROM pg_tables 
WHERE schemaname = 'documents' 
ORDER BY tablename;