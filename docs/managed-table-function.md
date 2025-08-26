# Managed Table Creation Function

## Overview

The `documents.create_managed_table` function provides a standardized way to create tables with:

- Consistent default columns
- Automatic ID generation
- Foreign key constraints
- Audit tracking
- Location-aware configuration

## Function Signature

```sql
CREATE OR REPLACE FUNCTION documents.create_managed_table(
    full_table_name TEXT,
    id_prefix TEXT,
    additional_columns TEXT
) RETURNS TEXT
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| full_table_name | TEXT | Fully qualified table name (schema.table) |
| id_prefix | TEXT | Prefix for ID sequence generation (should be unique per table) |
| additional_columns | TEXT | Additional column definitions (comma-separated) |

## Default Table Structure

All created tables include these standard columns:

| Column | Type | Description |
|--------|------|-------------|
| {table}_id | TEXT | Primary key with generated ID |
| company_id | TEXT | Foreign key to companies (except companies table) |
| created_at | TIMESTAMPTZ | Creation timestamp |
| created_by | TEXT | User who created record |
| modified_at | TIMESTAMPTZ | Last modification timestamp |
| modified_by | TEXT | User who last modified record |
| is_active | BOOLEAN | Active status flag |
| is_deleted | BOOLEAN | Soft delete flag |
| reference_data | JSONB | Flexible metadata storage |

## Features

### Automatic ID Generation

- Uses `generate_custom_id()` function with provided id_prefix
- Does not validate uniqueness of id_prefix - caller must ensure uniqueness
- Default column name derived from table name:
  - "companies" → "company_id"
  - "categories" → "category_id"
  - "users" → "user_id"

### Foreign Key Constraints

Automatically adds constraints for:

1. company_id → companies.company_id (except on companies table)
2. created_by → users.user_id
3. modified_by → users.user_id

### Audit Triggers

- `update_modified_at` trigger updates timestamps automatically
- Trigger names follow pattern: `update_{table}_modified_at`

### Location Awareness

- Reads location code from configs table
- Stores location context in config_sequence

## Usage Examples

### Basic Table Creation

```sql
SELECT documents.create_managed_table(
    'documents.invoices',
    'INV',  -- Unique prefix for invoice IDs
    'invoice_number TEXT, amount NUMERIC(10,2)'
);
```

## Error Handling

The function:

- Safely handles existing tables (IF NOT EXISTS)
- Checks for duplicate constraints before adding
- Does not validate id_prefix uniqueness
- Provides clear status messages

## Security

- Runs with SECURITY DEFINER privileges
- Grants ALL privileges to 'documents' role
- Owner is set to 'postgres'

## Dependencies

Requires these supporting functions:

1. `generate_custom_id()`
2. `documents.constraint_exists()`
3. `documents.update_modified_at()`
4. `current_schema()`

## Best Practices

1. Always use fully qualified table names
2. Choose meaningful and unique ID prefixes
3. Document additional columns thoroughly
4. Review constraint names for clarity
5. Implement id_prefix uniqueness validation at application level if needed
