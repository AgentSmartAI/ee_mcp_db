# PostgreSQL CDC Setup Guide with Debezium

## Overview

This guide helps you set up Change Data Capture (CDC) for your PostgreSQL database using Debezium. CDC will capture all INSERT, UPDATE, and DELETE operations and stream them to Kafka topics.

## Prerequisites

1. PostgreSQL with logical replication enabled
2. Kafka cluster running
3. Kafka Connect with Debezium PostgreSQL connector

## Step 1: Configure PostgreSQL for Logical Replication

### Check Current Configuration

Connect to your PostgreSQL database and run:

```sql
-- Check if logical replication is enabled
SHOW wal_level;
SHOW max_replication_slots;
SHOW max_wal_senders;
```

### Enable Logical Replication

If `wal_level` is not `logical`, update `postgresql.conf`:

```conf
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
```

Then restart PostgreSQL.

### Run Setup Script

Execute the setup script as superuser:

```bash
psql -h 172.21.89.238 -U postgres -d documents -f setup-postgres-cdc.sql
```

## Step 2: Configure the Debezium Connector

The `postgres-cdc-connector.json` file contains the connector configuration:

- **database.hostname**: Your PostgreSQL host (use `host.docker.internal` for local DB)
- **database.dbname**: Database name (`documents`)
- **schema.include.list**: Schema to capture (`documents`)
- **topic.prefix**: Prefix for Kafka topics (`cdc`)

### Important Configuration Options

1. **snapshot.mode**: 
   - `initial` - Snapshot existing data then stream changes
   - `never` - Only stream new changes
   - `initial_only` - Only snapshot, no streaming

2. **publication.autocreate.mode**:
   - `filtered` - Only replicate included tables
   - `all_tables` - Replicate all tables

3. **decimal.handling.mode**:
   - `string` - Convert decimals to strings (recommended)
   - `precise` - Use Java BigDecimal

## Step 3: Deploy the Connector

### Create the Connector

```bash
cd /home/block/git/ee_mcp_db_seq_file/docs
./manage-postgres-connector.sh create
```

### Check Status

```bash
./manage-postgres-connector.sh status
```

### View Created Topics

```bash
./manage-postgres-connector.sh topics
```

## Step 4: Verify CDC is Working

### 1. Check Kafka Topics

Topics will be created with pattern: `postgres.documents.<table_name>`

View in Kafka UI: http://localhost:8080

### 2. Test Data Changes

```sql
-- Insert test data
INSERT INTO documents.your_table (column1, column2) 
VALUES ('test1', 'value1');

-- Update data
UPDATE documents.your_table 
SET column2 = 'updated_value' 
WHERE column1 = 'test1';

-- Delete data
DELETE FROM documents.your_table 
WHERE column1 = 'test1';
```

### 3. View Events in Kafka

Each operation creates an event with:
- `before`: State before change (null for INSERT)
- `after`: State after change (null for DELETE)
- `op`: Operation type (c=create, u=update, d=delete, r=read)
- `ts_ms`: Timestamp
- `source`: Metadata about the source

Example INSERT event:
```json
{
  "before": null,
  "after": {
    "id": 1,
    "column1": "test1",
    "column2": "value1"
  },
  "source": {
    "version": "2.4.0.Final",
    "connector": "postgresql",
    "name": "pgserver",
    "ts_ms": 1704067200000,
    "snapshot": "false",
    "db": "documents",
    "schema": "documents",
    "table": "your_table"
  },
  "op": "c",
  "ts_ms": 1704067200500
}
```

## Step 5: Monitor and Manage

### View Connector Metrics

```bash
# Get detailed status
curl -s http://localhost:8083/connectors/postgres-cdc-connector/status | jq .

# View tasks
./manage-postgres-connector.sh tasks
```

### Common Operations

```bash
# Restart connector
./manage-postgres-connector.sh restart

# Update configuration
# Edit postgres-cdc-connector.json then:
./manage-postgres-connector.sh update

# Delete connector
./manage-postgres-connector.sh delete
```

## Troubleshooting

### 1. Connector Fails to Start

Check logs:
```bash
docker logs kafka-connect | grep ERROR
```

Common issues:
- Wrong database credentials
- PostgreSQL not configured for logical replication
- Network connectivity issues

### 2. No Events in Kafka

- Verify replication slot exists: `SELECT * FROM pg_replication_slots;`
- Check publication: `SELECT * FROM pg_publication_tables;`
- Ensure user has REPLICATION permission

### 3. Snapshot Takes Too Long

For large tables, consider:
- Setting `snapshot.mode` to `never` 
- Using `snapshot.select.statement.overrides` to filter data
- Increasing `snapshot.fetch.size`

### 4. Replication Lag

Monitor replication slot lag:
```sql
SELECT slot_name, active, restart_lsn, 
       pg_current_wal_lsn() - restart_lsn as lag_bytes
FROM pg_replication_slots;
```

## Integration with MCP Events

Now you have two event streams:

1. **MCP Events** (`mcp-events` topic): Application-level events
   - Query executions
   - Errors
   - Performance metrics

2. **CDC Events** (`postgres.documents.*` topics): Database-level changes
   - All data modifications
   - Schema changes

You can correlate these streams using timestamps and session IDs to get a complete picture of your system's behavior.

## Best Practices

1. **Monitoring**: Set up alerts for connector failures
2. **Retention**: Configure appropriate retention for CDC topics
3. **Filtering**: Use `table.include.list` to capture only needed tables
4. **Performance**: Monitor replication slot lag
5. **Security**: Use SSL and authentication in production

## Next Steps

1. Set up consumers to process CDC events
2. Build materialized views or search indexes
3. Implement event-driven workflows
4. Create audit trails from CDC events