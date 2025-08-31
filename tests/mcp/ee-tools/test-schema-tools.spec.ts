/**
 * Tests for MCP server schema exploration tools.
 * Validates table listing, description, and relationship mapping.
 */

import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP EE-Tools Schema Tools Tests', () => {
  let client: MCPClient;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
        LOG_LEVEL: 'error'
      }
    });

    client = new MCPClient({
      name: 'test-client',
      version: '1.0.0'
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('Table Listing', () => {
    test('should list all tables in default schema', async () => {
      const result = await client.callTool('list_tables', {});

      expect(result).toMatchObject({
        success: true,
        schema: 'documents',
        tableCount: expect.any(Number),
        tables: expect.arrayContaining([
          expect.objectContaining({
            schema: 'documents',
            table: expect.any(String),
            owner: expect.any(String)
          })
        ])
      });

      expect(result.tableCount).toBeGreaterThan(0);
      expect(result.tableCount).toBe(result.tables.length);
    });

    test('should include table sizes when requested', async () => {
      const result = await client.callTool('list_tables', {
        includeSize: true
      });

      expect(result.success).toBe(true);
      result.tables.forEach((table: any) => {
        expect(table).toHaveProperty('size');
        expect(table.size).toMatch(/^\d+\s*(bytes|kB|MB|GB)$/);
      });
    });

    test('should filter tables by pattern', async () => {
      const result = await client.callTool('list_tables', {
        pattern: 'user%'
      });

      expect(result.success).toBe(true);
      result.tables.forEach((table: any) => {
        expect(table.table).toMatch(/^user/);
      });
    });

    test('should handle specific schema', async () => {
      const result = await client.callTool('list_tables', {
        schema: 'documents'
      });

      expect(result.success).toBe(true);
      expect(result.schema).toBe('documents');
      result.tables.forEach((table: any) => {
        expect(table.schema).toBe('documents');
      });
    });

    test('should exclude system tables by default', async () => {
      const result = await client.callTool('list_tables', {
        includeSystemTables: false
      });

      expect(result.success).toBe(true);
      
      const systemTables = result.tables.filter((table: any) => 
        table.table.startsWith('pg_') || table.table.startsWith('sql_')
      );
      expect(systemTables).toHaveLength(0);
    });

    test('should handle pattern with wildcards', async () => {
      const result = await client.callTool('list_tables', {
        pattern: '%_h' // Tables ending with _h (history tables)
      });

      expect(result.success).toBe(true);
      result.tables.forEach((table: any) => {
        expect(table.table).toMatch(/_h$/);
      });
    });
  });

  describe('Table Description', () => {
    test('should describe table structure', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        schema: 'documents'
      });

      expect(result).toMatchObject({
        success: true,
        schema: 'documents',
        table: 'users',
        tableInfo: expect.objectContaining({
          totalSize: expect.any(String),
          tableSize: expect.any(String),
          indexesSize: expect.any(String),
          estimatedRowCount: expect.any(Number)
        }),
        columns: expect.arrayContaining([
          expect.objectContaining({
            column_name: 'user_id',
            data_type: 'text',
            is_nullable: 'NO'
          })
        ]),
        metadata: expect.objectContaining({
          columnCount: expect.any(Number),
          constraintCount: expect.any(Number),
          indexCount: expect.any(Number),
          relationshipCount: expect.any(Number)
        })
      });
    });

    test('should include column details', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users'
      });

      expect(result.success).toBe(true);
      
      const userIdColumn = result.columns.find((col: any) => col.column_name === 'user_id');
      expect(userIdColumn).toMatchObject({
        column_name: 'user_id',
        data_type: 'text',
        is_nullable: 'NO',
        ordinal_position: 1,
        column_default: expect.stringContaining('generate_custom_id')
      });

      const emailColumn = result.columns.find((col: any) => col.column_name === 'email');
      expect(emailColumn).toMatchObject({
        column_name: 'email',
        data_type: 'text',
        is_nullable: 'NO'
      });
    });

    test('should include constraints', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeConstraints: true
      });

      expect(result.success).toBe(true);
      expect(result.constraints).toBeDefined();
      
      // Check for primary key
      const primaryKey = result.constraints.find((c: any) => c.constraint_type === 'PRIMARY KEY');
      expect(primaryKey).toBeDefined();
      expect(primaryKey.column_name).toBe('user_id');

      // Check for unique constraints
      const uniqueConstraints = result.constraints.filter((c: any) => c.constraint_type === 'UNIQUE');
      expect(uniqueConstraints.length).toBeGreaterThan(0);

      // Check for foreign keys
      const foreignKeys = result.constraints.filter((c: any) => c.constraint_type === 'FOREIGN KEY');
      expect(foreignKeys.length).toBeGreaterThan(0);
    });

    test('should include indexes', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeIndexes: true
      });

      expect(result.success).toBe(true);
      expect(result.indexes).toBeDefined();
      expect(result.indexes.length).toBeGreaterThan(0);

      result.indexes.forEach((index: any) => {
        expect(index).toHaveProperty('index_name');
        expect(index).toHaveProperty('is_primary');
        expect(index).toHaveProperty('is_unique');
        expect(index).toHaveProperty('definition');
        expect(index).toHaveProperty('size');
      });

      // Verify primary key index exists
      const pkIndex = result.indexes.find((idx: any) => idx.is_primary);
      expect(pkIndex).toBeDefined();
    });

    test('should include relationships', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeRelationships: true
      });

      expect(result.success).toBe(true);
      expect(result.relationships).toBeDefined();
      
      const outboundRels = result.relationships.filter((r: any) => r.relationship_type === 'REFERENCES');
      const inboundRels = result.relationships.filter((r: any) => r.relationship_type === 'REFERENCED BY');
      
      expect(outboundRels.length).toBeGreaterThan(0);
      expect(inboundRels.length).toBeGreaterThan(0);

      // Check relationship details
      outboundRels.forEach((rel: any) => {
        expect(rel).toHaveProperty('constraint_name');
        expect(rel).toHaveProperty('related_table');
        expect(rel).toHaveProperty('local_columns');
        expect(rel).toHaveProperty('foreign_columns');
      });
    });

    test('should limit inbound relationships', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeRelationships: true,
        maxInboundRelationships: 5
      });

      expect(result.success).toBe(true);
      
      const inboundRels = result.relationships.filter((r: any) => r.relationship_type === 'REFERENCED BY');
      expect(inboundRels.length).toBeLessThanOrEqual(5);

      if (result.relationshipSummary && result.relationshipSummary.inbound.truncated) {
        expect(result.relationshipSummary.inbound.note).toContain('Use maxInboundRelationships');
      }
    });

    test('should handle tables without relationships', async () => {
      // Assuming there's a table with no foreign keys
      const result = await client.callTool('describe_table', {
        table: 'debezium_signal', // System table typically has no relationships
        includeRelationships: true
      });

      expect(result.success).toBe(true);
      expect(result.relationships).toBeDefined();
      expect(result.relationshipSummary.outbound).toBe(0);
    });
  });

  describe('Data Type Information', () => {
    test('should provide detailed type information', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users'
      });

      expect(result.success).toBe(true);

      // Check various data types
      const columns = result.columns;
      
      // Text columns
      const textColumns = columns.filter((col: any) => col.data_type === 'text');
      expect(textColumns.length).toBeGreaterThan(0);

      // Timestamp columns
      const timestampColumns = columns.filter((col: any) => col.data_type.includes('timestamp'));
      expect(timestampColumns.length).toBeGreaterThan(0);

      // Boolean columns
      const boolColumns = columns.filter((col: any) => col.data_type === 'boolean');
      expect(boolColumns.length).toBeGreaterThan(0);

      // JSONB columns
      const jsonbColumns = columns.filter((col: any) => col.data_type === 'jsonb');
      expect(jsonbColumns.length).toBeGreaterThan(0);
    });

    test('should include precision and scale for numeric types', async () => {
      // Find a table with numeric columns
      const result = await client.callTool('describe_table', {
        table: 'job_budget'
      });

      expect(result.success).toBe(true);
      
      const numericColumns = result.columns.filter((col: any) => 
        col.data_type === 'numeric' || col.data_type === 'integer'
      );

      if (numericColumns.length > 0) {
        numericColumns.forEach((col: any) => {
          expect(col).toHaveProperty('numeric_precision');
          expect(col).toHaveProperty('numeric_scale');
        });
      }
    });
  });

  describe('Schema Navigation', () => {
    test('should navigate parent-child relationships', async () => {
      // Get companies table info
      const companiesResult = await client.callTool('describe_table', {
        table: 'companies',
        includeRelationships: true
      });

      expect(companiesResult.success).toBe(true);
      
      // Find child tables (tables referencing companies)
      const childRelationships = companiesResult.relationships.filter(
        (r: any) => r.relationship_type === 'REFERENCED BY'
      );
      
      expect(childRelationships.length).toBeGreaterThan(0);
      
      // Verify users table references companies
      const userRelationship = childRelationships.find(
        (r: any) => r.related_table === 'documents.users'
      );
      expect(userRelationship).toBeDefined();
    });

    test('should identify self-referential relationships', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeRelationships: true
      });

      expect(result.success).toBe(true);
      
      // Users table has created_by and modified_by that reference itself
      const selfRefs = result.relationships.filter(
        (r: any) => r.relationship_type === 'REFERENCES' && r.related_table === 'documents.users'
      );
      
      expect(selfRefs.length).toBeGreaterThan(0);
    });
  });

  describe('Performance Considerations', () => {
    test('should handle large schemas efficiently', async () => {
      const startTime = Date.now();
      
      const result = await client.callTool('list_tables', {
        includeSize: true
      });
      
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    test('should provide metadata about query performance', async () => {
      const result = await client.callTool('describe_table', {
        table: 'users',
        includeConstraints: true,
        includeIndexes: true,
        includeRelationships: true
      });

      expect(result.success).toBe(true);
      expect(result.metadata.duration).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThan(0);
    });
  });

  describe('Error Handling in Schema Tools', () => {
    test('should handle non-existent table gracefully', async () => {
      const result = await client.callTool('describe_table', {
        table: 'nonexistent_table'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
      
      if (result.suggestion) {
        expect(result.suggestion).toContain('list_tables');
      }
    });

    test('should handle invalid schema name', async () => {
      const result = await client.callTool('list_tables', {
        schema: 'invalid_schema'
      });

      expect(result.success).toBe(true);
      expect(result.tableCount).toBe(0);
      expect(result.tables).toHaveLength(0);
    });

    test('should validate required parameters', async () => {
      try {
        await client.callTool('describe_table', {});
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toMatch(/required|table/i);
      }
    });
  });
});