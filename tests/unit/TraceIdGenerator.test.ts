/**
 * Unit tests for TraceIdGenerator
 */

import { TraceIdGenerator } from '../../src/utils/TraceIdGenerator';

describe('TraceIdGenerator', () => {
  describe('generate', () => {
    it('should generate a trace ID with correct format', () => {
      const traceId = TraceIdGenerator.generate();
      expect(traceId).toMatch(/^mcp_\d+_[a-z0-9]+$/);
    });

    it('should generate unique trace IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(TraceIdGenerator.generate());
      }
      expect(ids.size).toBe(100);
    });

    it('should include timestamp in trace ID', () => {
      const before = Date.now();
      const traceId = TraceIdGenerator.generate();
      const after = Date.now();
      
      const timestamp = TraceIdGenerator.extractTimestamp(traceId);
      expect(timestamp).not.toBeNull();
      expect(timestamp!).toBeGreaterThanOrEqual(before);
      expect(timestamp!).toBeLessThanOrEqual(after);
    });
  });

  describe('generateChild', () => {
    it('should generate child trace ID with correct format', () => {
      const parentId = 'mcp_1704067200000_abc123';
      const childId = TraceIdGenerator.generateChild(parentId, 1);
      expect(childId).toBe('mcp_1704067200000_abc123_sub_1');
    });

    it('should handle different sequence numbers', () => {
      const parentId = 'mcp_1704067200000_abc123';
      expect(TraceIdGenerator.generateChild(parentId, 1)).toBe('mcp_1704067200000_abc123_sub_1');
      expect(TraceIdGenerator.generateChild(parentId, 2)).toBe('mcp_1704067200000_abc123_sub_2');
      expect(TraceIdGenerator.generateChild(parentId, 10)).toBe('mcp_1704067200000_abc123_sub_10');
    });
  });

  describe('extractTimestamp', () => {
    it('should extract timestamp from valid trace ID', () => {
      const traceId = 'mcp_1704067200000_abc123';
      const timestamp = TraceIdGenerator.extractTimestamp(traceId);
      expect(timestamp).toBe(1704067200000);
    });

    it('should extract timestamp from child trace ID', () => {
      const traceId = 'mcp_1704067200000_abc123_sub_1';
      const timestamp = TraceIdGenerator.extractTimestamp(traceId);
      expect(timestamp).toBe(1704067200000);
    });

    it('should return null for invalid trace ID', () => {
      expect(TraceIdGenerator.extractTimestamp('invalid')).toBeNull();
      expect(TraceIdGenerator.extractTimestamp('mcp_invalid_abc123')).toBeNull();
      expect(TraceIdGenerator.extractTimestamp('')).toBeNull();
    });
  });

  describe('isValid', () => {
    it('should validate correct trace IDs', () => {
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123')).toBe(true);
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123def456')).toBe(true);
      expect(TraceIdGenerator.isValid('mcp_1_a')).toBe(true);
    });

    it('should validate child trace IDs', () => {
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123_sub_1')).toBe(true);
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123_sub_999')).toBe(true);
    });

    it('should reject invalid trace IDs', () => {
      expect(TraceIdGenerator.isValid('invalid')).toBe(false);
      expect(TraceIdGenerator.isValid('mcp_')).toBe(false);
      expect(TraceIdGenerator.isValid('mcp_abc_123')).toBe(false);
      expect(TraceIdGenerator.isValid('MCP_1704067200000_abc123')).toBe(false); // uppercase
      expect(TraceIdGenerator.isValid('mcp_1704067200000_ABC123')).toBe(false); // uppercase
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123_sub_')).toBe(false);
      expect(TraceIdGenerator.isValid('mcp_1704067200000_abc123_sub_abc')).toBe(false);
      expect(TraceIdGenerator.isValid('')).toBe(false);
    });
  });
});