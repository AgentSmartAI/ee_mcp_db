/**
 * Tool for retrieving top priority tasks and bugs from the system.
 * Supports filtering by project, user, task type, and search criteria.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, MCPError } from '../types/index.js';

export interface GetTasksArgs {
  project_id?: string;
  user_id?: string;
  job_id?: string;
  task_type?: 'user' | 'project';
  inc_bugs?: boolean;
  search_string?: string;
  module_name?: string;
}

export interface TaskResult {
  id: string;
  type: 'task' | 'bug';
  title: string;
  description: string;
  priority: number;
  status: string;
  created_at: string;
  age_days: number;
  project_id?: string;
  user_id?: string;
  task_type?: string;
  file_path?: string;
  job_id?: string;
  job_description?: string;
  job_context?: any;
  task_prompt?: string;
  task_name?: string;
  task_priority?: number;
  started_at?: string;
  modified_at?: string;
  modified_by?: string;
  reference_data?: any;
}

export class GetTasksTool implements MCPTool<GetTasksArgs> {
  name = 'get_tasks';
  description =
    'Retrieve top priority tasks or bugs based on priority and age, with filtering options';

  inputSchema = {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Filter by specific project ID (required)',
      },
      user_id: {
        type: 'string',
        description: 'Filter by specific user ID',
      },
      job_id: {
        type: 'string',
        description: 'Filter by specific job ID (tasks where parent_id = job_id)',
      },
      task_type: {
        type: 'string',
        enum: ['user', 'project'],
        description: 'Filter by task scope type',
      },
      inc_bugs: {
        type: 'boolean',
        description: 'Include bugs in results (default: false)',
        default: false,
      },
      search_string: {
        type: 'string',
        description: 'Search in task/bug names and descriptions',
      },
      module_name: {
        type: 'string',
        description: 'Filter by module name in reference_data or file_path',
      },
    },
    required: ['project_id'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private queryValidator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector
  ) {}

  async execute(args: GetTasksArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const traceId =
      context?.traceId || `get_tasks_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    this.logger.info(
      'GetTasks request received',
      {
        requestId,
        traceId,
        args,
      },
      'PopTaskTool'
    );

    // Validate required project_id parameter
    if (!args.project_id) {
      const mcpError: MCPError = {
        code: 'MISSING_PROJECT_ID',
        message: 'project_id is required. Check your .env file for DEFAULT_PROJECT_ID or pass it in the context.',
        details: {
          requestId,
          traceId,
          hint: 'Set DEFAULT_PROJECT_ID in your .env file or provide project_id parameter',
        },
      };

      this.logger.error('GetTasks failed - missing project_id', mcpError, 'GetTasksTool');

      return {
        content: [
          {
            type: 'text',
            text: `Error: ${mcpError.message}`,
          },
        ],
        metadata: {
          error: mcpError,
          requestId,
          traceId,
          duration_ms: 0,
        },
      };
    }

    try {
      // Add explicit timeout wrapper around the entire operation
      const results = await Promise.race([
        this.getTopTasks(args, requestId, traceId),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('GetTasks operation timed out after 15 seconds'));
          }, 15000); // 15 second total timeout
        }),
      ]);
      const duration = Date.now() - startTime;

      this.logger.info(
        'GetTasks completed successfully',
        {
          requestId,
          traceId,
          resultCount: results.length,
        },
        'PopTaskTool'
      );

      // Emit success event (fire-and-forget)
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(EventType.QUERY_EXECUTED, {
            requestId,
            traceId,
            tool: 'pop_task',
            success: true,
            resultCount: results.length,
            filters: args,
          })
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: this.formatResults(results),
          },
        ],
        metadata: {
          resultCount: results.length,
          filters: args,
          requestId,
          traceId,
          duration_ms: duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const mcpError: MCPError = {
        code: 'POP_TASK_FAILED',
        message: `Failed to retrieve tasks: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          requestId,
          traceId,
          args,
        },
      };

      this.logger.error('PopTask failed', mcpError, 'PopTaskTool');

      // Emit failure event (fire-and-forget)
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(EventType.QUERY_FAILED, {
            requestId,
            traceId,
            tool: 'pop_task',
            error: mcpError,
            filters: args,
          })
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving tasks: ${mcpError.message}`,
          },
        ],
        metadata: {
          error: mcpError,
          requestId,
          traceId,
          duration_ms: duration,
        },
      };
    }
  }

  private async getTopTasks(
    args: GetTasksArgs,
    requestId: string,
    traceId: string
  ): Promise<TaskResult[]> {
    // First, let's check if tables exist and get a quick count
    try {
      const countResult = await this.connectionManager.executeQuery(
        `SELECT 
          (SELECT COUNT(*) FROM tasks WHERE is_active = true AND is_deleted = false AND valid_to IS NULL) as task_count,
          (SELECT COUNT(*) FROM bugs WHERE is_active = true AND is_deleted = false) as bug_count`,
        [],
        5000 // 5 second timeout for count
      );

      this.logger.debug(
        'Table counts for PopTask',
        {
          requestId,
          traceId,
          taskCount: countResult.rows[0]?.task_count || 0,
          bugCount: countResult.rows[0]?.bug_count || 0,
        },
        'PopTaskTool'
      );

      // If no data, return empty
      const taskCount = parseInt(countResult.rows[0]?.task_count || '0');
      const bugCount = parseInt(countResult.rows[0]?.bug_count || '0');

      if (taskCount === 0 && (bugCount === 0 || !args.inc_bugs)) {
        this.logger.info(
          'No tasks or bugs found, returning empty result',
          { requestId, traceId },
          'PopTaskTool'
        );
        return [];
      }
    } catch (error) {
      this.logger.warn(
        'Failed to get table counts, proceeding with query',
        {
          requestId,
          traceId,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
        'PopTaskTool'
      );
    }

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Build optimized task query with LIMIT before UNION
    let taskQuery = `
      SELECT 
        t.task_id as id,
        'task' as type,
        t.task_name as title,
        t.task_description as description,
        t.task_priority as priority,
        t.task_status as status,
        t.created_at,
        DATE_PART('day', NOW() - t.created_at) as age_days,
        t.project_id,
        t.user_id,
        t.task_type,
        t.file_path,
        t.task_prompt,
        t.started_at,
        t.modified_at,
        t.modified_by,
        CASE 
          WHEN j.job_id IS NOT NULL THEN j.job_id 
          ELSE NULL 
        END as job_id,
        j.job_description,
        j.job_context,
        t.reference_data
      FROM tasks t
      LEFT JOIN jobs j ON t.parent_id = j.job_id
      WHERE t.is_active = true 
        AND t.is_deleted = false
        AND t.valid_to IS NULL
        AND t.task_status NOT IN ('completed', 'in_progress', 'cancelled', 'archived')
    `;

    // Add task filters
    if (args.project_id) {
      conditions.push(`t.project_id = $${paramIndex++}`);
      params.push(args.project_id);
    }

    if (args.user_id) {
      conditions.push(`t.user_id = $${paramIndex++}`);
      params.push(args.user_id);
    }

    if (args.job_id) {
      conditions.push(`t.parent_id = $${paramIndex++}`);
      params.push(args.job_id);
    }

    if (args.task_type) {
      conditions.push(`t.parent_type = $${paramIndex++}`);
      params.push(args.task_type);
    }

    if (args.search_string) {
      conditions.push(
        `(t.task_name ILIKE $${paramIndex} OR t.task_description ILIKE $${paramIndex})`
      );
      params.push(`%${args.search_string}%`);
      paramIndex++;
    }

    if (args.module_name) {
      conditions.push(`(t.file_path ILIKE $${paramIndex})`);
      params.push(`%${args.module_name}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      taskQuery += ' AND ' + conditions.join(' AND ');
    }

    // Add ordering and limit to task query BEFORE union
    taskQuery += `
      ORDER BY 
        t.task_priority ASC,  -- Priority 1 is highest/most urgent, 5 is lowest
        DATE_PART('day', NOW() - t.created_at) DESC,
        t.created_at ASC
      LIMIT 2
    `;

    let finalQuery = `(${taskQuery})`;

    // Add bug query if requested
    if (args.inc_bugs) {
      const bugConditions = [];
      let bugParamIndex = paramIndex;

      let bugQuery = `
        SELECT 
          b.bug_id as id,
          'bug' as type,
          b.title,
          b.description,
          b.priority,
          b.status,
          b.created_at,
          DATE_PART('day', NOW() - b.created_at) as age_days,
          b.project_id,
          b.user_id,
          b.bug_type as task_type,
          b.file_path,
          NULL as task_prompt,
          NULL as started_at,
          b.modified_at,
          b.modified_by,
          CASE 
            WHEN j.job_id IS NOT NULL THEN j.job_id 
            ELSE NULL 
          END as job_id,
          j.job_description,
          j.job_context,
          b.reference_data
        FROM bugs b
        LEFT JOIN jobs j ON b.parent_id = j.job_id
        WHERE b.is_active = true 
          AND b.is_deleted = false
          AND b.status NOT IN ('closed', 'resolved', 'duplicate', 'rejected')
      `;

      if (args.project_id) {
        bugConditions.push(`b.project_id = $${bugParamIndex++}`);
      }

      if (args.user_id) {
        bugConditions.push(`b.user_id = $${bugParamIndex++}`);
      }

      if (args.job_id) {
        bugConditions.push(`b.parent_id = $${bugParamIndex++}`);
      }

      if (args.search_string) {
        bugConditions.push(
          `(b.title ILIKE $${bugParamIndex} OR b.description ILIKE $${bugParamIndex})`
        );
        bugParamIndex++;
      }

      if (args.module_name) {
        bugConditions.push(`(b.file_path ILIKE $${bugParamIndex})`);
        bugParamIndex++;
      }

      if (bugConditions.length > 0) {
        bugQuery += ' AND ' + bugConditions.join(' AND ');
      }

      // Add ordering and limit to bug query BEFORE union
      bugQuery += `
        ORDER BY 
          b.priority ASC,  -- Priority 1 is highest/most urgent, 5 is lowest
          DATE_PART('day', NOW() - b.created_at) DESC,
          b.created_at ASC
        LIMIT 2
      `;

      finalQuery = `
        ${finalQuery}
        UNION ALL
        (${bugQuery})
      `;

      // Duplicate params for bug query
      if (args.project_id) params.push(args.project_id);
      if (args.user_id) params.push(args.user_id);
      if (args.job_id) params.push(args.job_id);
      if (args.search_string) params.push(`%${args.search_string}%`);
      if (args.module_name) params.push(`%${args.module_name}%`);
    }

    // Final ordering and limit
    finalQuery = `
      SELECT * FROM (${finalQuery}) combined
      ORDER BY 
        priority ASC,  -- Priority 1 is highest/most urgent, 5 is lowest
        age_days DESC,
        created_at ASC
      LIMIT 1
    `;

    this.logger.debug(
      'Executing optimized PopTask query',
      {
        requestId,
        traceId,
        paramCount: params.length,
        includesBugs: args.inc_bugs,
        queryLength: finalQuery.length,
      },
      'PopTaskTool'
    );

    try {
      const result = await this.connectionManager.executeQuery(finalQuery, params, 8000); // 8 second timeout

      this.logger.debug(
        'PopTask query completed',
        {
          requestId,
          traceId,
          rowCount: result.rows.length,
          executionTime: result.executionTime,
        },
        'PopTaskTool'
      );

      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        description: row.description,
        priority: row.priority,
        status: row.status,
        created_at: row.created_at,
        age_days: row.age_days,
        project_id: row.project_id,
        user_id: row.user_id,
        task_type: row.task_type,
        file_path: row.file_path,
        job_id: row.job_id,
        job_description: row.job_description,
        job_context: row.job_context,
        task_prompt: row.task_prompt,
        task_name: row.task_name,
        task_priority: row.task_priority,
        started_at: row.started_at,
        modified_at: row.modified_at,
        modified_by: row.modified_by,
      }));
    } catch (error) {
      this.logger.error(
        'PopTask query failed',
        {
          requestId,
          traceId,
          error: { message: error instanceof Error ? error.message : String(error) },
          queryLength: finalQuery.length,
          paramCount: params.length,
        },
        'PopTaskTool'
      );

      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`PopTask query failed: ${error.message}`);
      }
      throw new Error(`PopTask query failed: ${String(error)}`);
    }
  }

  private formatResults(results: TaskResult[]): string {
    if (results.length === 0) {
      return 'No tasks or bugs found matching the specified criteria.';
    }

    let output = `Found ${results.length} top priority items:\n\n`;

    results.forEach((item, index) => {
      output += `${index + 1}. [${item.type.toUpperCase()}] ${item.title}\n`;
      output += `   ID: ${item.id}\n`;
      output += `   Priority: ${item.priority}\n`;
      output += `   Status: ${item.status}\n`;
      output += `   Age: ${item.age_days} days\n`;

      if (item.project_id) {
        output += `   Project: ${item.project_id}\n`;
      }

      if (item.user_id) {
        output += `   Assigned to: ${item.user_id}\n`;
      }

      if (item.task_type) {
        output += `   Type: ${item.task_type}\n`;
      }

      if (item.file_path) {
        output += `   File: ${item.file_path}\n`;
      }

      if (item.task_prompt) {
        output += `   Prompt: ${item.task_prompt.substring(0, 80)}${item.task_prompt.length > 80 ? '...' : ''}\n`;
      }

      if (item.started_at) {
        output += `   Started: ${new Date(item.started_at).toLocaleString()}\n`;
      }

      if (item.modified_at) {
        output += `   Modified: ${new Date(item.modified_at).toLocaleString()}\n`;
      }

      if (item.modified_by) {
        output += `   Modified by: ${item.modified_by}\n`;
      }

      if (item.job_id) {
        output += `   Job ID: ${item.job_id}\n`;
      }

      if (item.job_description) {
        output += `   Job Description: ${item.job_description.substring(0, 80)}${item.job_description.length > 80 ? '...' : ''}\n`;
      }

      if (item.job_context) {
        const contextStr =
          typeof item.job_context === 'string'
            ? item.job_context
            : JSON.stringify(item.job_context, null, 2);
        output += `   Job Context: ${contextStr.substring(0, 100)}${contextStr.length > 100 ? '...' : ''}\n`;
      }

      // Extract module from reference_data if available
      if (item.reference_data) {
        const refData =
          typeof item.reference_data === 'string'
            ? JSON.parse(item.reference_data)
            : item.reference_data;

        if (refData.module_name) {
          output += `   Module: ${refData.module_name}\n`;
        }

        // Also display other potentially useful reference data
        if (refData.function_name) {
          output += `   Function: ${refData.function_name}\n`;
        }

        if (refData.class_name) {
          output += `   Class: ${refData.class_name}\n`;
        }
      }

      output += `   Description: ${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}\n`;
      output += `   Created: ${new Date(item.created_at).toLocaleString()}\n\n`;
    });

    return output;
  }
}
