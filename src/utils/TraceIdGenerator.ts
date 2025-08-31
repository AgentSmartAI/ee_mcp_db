/**
 * Generates unique trace IDs for MCP transactions to enable tracking and debugging.
 * Uses timestamp and random components for uniqueness and ordering.
 */

export class TraceIdGenerator {
  /**
   * Generate a unique trace ID with format: mcp_[timestamp]_[random]
   * Example: mcp_1704067200000_a1b2c3d4
   */
  static generate(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `mcp_${timestamp}_${random}`;
  }

  /**
   * Generate a child trace ID from a parent trace ID
   * Useful for tracking sub-operations within a transaction
   * Example: mcp_1704067200000_a1b2c3d4_sub_1
   */
  static generateChild(parentTraceId: string, sequence: number): string {
    return `${parentTraceId}_sub_${sequence}`;
  }

  /**
   * Extract timestamp from trace ID
   */
  static extractTimestamp(traceId: string): number | null {
    const match = traceId.match(/mcp_(\d+)_/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Validate trace ID format
   */
  static isValid(traceId: string): boolean {
    return /^mcp_\d+_[a-z0-9]+(_sub_\d+)?$/.test(traceId);
  }
}
