/**
 * Tool for creating new tasks in the system.
 * Supports session, project, and user scope types with comprehensive task creation.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, MCPError } from '../types/index.js';

export interface CreateTaskArgs {
  task_name: string;
  task_description: string;
  parent_id: string; // Can point to any entity (job, project, task, use_case, etc.) since IDs are globally unique
  user_id: string;
  project_id: string;
  task_type?: 'session' | 'project' | 'user';
  task_priority?: number;
  task_prompt?: string;
  task_status?: string;
  file_path?: string;
  session_id?: string;
  reference_data?: Record<string, any>;
  callback_config?: Record<string, any>;
}

export interface CreateTaskResult {
  task_id: string;
  task_name: string;
  task_description: string;
  task_type: string;
  task_priority: number;
  task_status: string;
  project_id: string;
  user_id: string;
  created_at: string;
  parent_id: string;
  session_id?: string;
}

export class CreateTaskTool implements MCPTool<CreateTaskArgs> {
  name = 'create_task';
  description =
    'Create a new task with session, project, or user scope. Supports comprehensive task configuration including priorities, prompts, and reference data.';

  inputSchema = {
    type: 'object',
    properties: {
      task_name: {
        type: 'string',
        description: 'Name/title of the task (required)',
      },
      task_description: {
        type: 'string',
        description: 'Detailed description of the task (required)',
      },
      parent_id: {
        type: 'string',
        description:
          'Parent entity ID - can point to any entity (job, project, task, use_case, etc.) since IDs are globally unique',
      },
      user_id: {
        type: 'string',
        description: 'User ID assigned to this task (required)',
      },
      project_id: {
        type: 'string',
        description: 'Project ID this task belongs to (required)',
      },
      task_type: {
        type: 'string',
        enum: ['session', 'project', 'user'],
        description: 'Task scope type (default: project)',
        default: 'project',
      },
      task_priority: {
        type: 'integer',
        description: 'Task priority (1=highest/urgent, 100=lowest, default: 25)',
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      task_prompt: {
        type: 'string',
        description: 'Optional AI prompt or instructions for task execution',
      },
      task_status: {
        type: 'string',
        description: 'Initial task status (default: pending)',
        default: 'pending',
      },
      file_path: {
        type: 'string',
        description: 'Associated file path for file-related tasks',
      },
      session_id: {
        type: 'string',
        description: 'Session ID for session-scoped tasks',
      },
      reference_data: {
        type: 'object',
        description: 'Additional JSON data for task context',
      },
      callback_config: {
        type: 'object',
        description: 'Configuration for task completion callbacks',
      },
    },
    required: ['task_name', 'task_description', 'parent_id', 'user_id', 'project_id'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private queryValidator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector
  ) {}

  async execute(args: CreateTaskArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const traceId =
      context?.traceId || `create_task_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    this.logger.info(
      'CreateTask request received',
      {
        requestId,
        traceId,
        task_name: args.task_name,
        task_type: args.task_type || 'project',
        user_id: args.user_id,
        project_id: args.project_id,
      },
      'CreateTaskTool'
    );

    try {
      const result = await Promise.race([
        this.createTask(args, requestId, traceId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CreateTask operation timed out')), 30000)
        ),
      ]);

      const duration = Date.now() - startTime;

      this.logger.info(
        'CreateTask completed successfully',
        {
          requestId,
          traceId,
          duration,
          task_id: result.task_id,
          task_type: result.task_type,
        },
        'CreateTaskTool'
      );

      // Emit success event
      if (this.eventCollector) {
        const event = createEvent(EventType.TASK_CREATED, {
          requestId,
          traceId,
          task_id: result.task_id,
          task_name: result.task_name,
          task_type: result.task_type,
          project_id: result.project_id,
          duration,
        });
        this.eventCollector.collect(event);
      }

      // Include trace_id in the response for log lookup
      const responseWithTrace = {
        ...result,
        trace_id: traceId,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseWithTrace, null, 2),
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId,
          task_id: result.task_id,
          task_type: result.task_type,
          created_at: result.created_at,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error('CreateTask failed', error as Error, 'CreateTaskTool');

      // Emit error event
      if (this.eventCollector) {
        const event = createEvent(EventType.ERROR_DETECTED, {
          requestId,
          traceId,
          tool: 'create_task',
          error: errorMessage,
          duration,
        });
        this.eventCollector.collect(event);
      }

      const enhancedError = new Error(`Failed to create task: ${errorMessage}`);
      (enhancedError as any).code = 'INTERNAL_ERROR';
      throw enhancedError;
    }
  }

  private async createTask(
    args: CreateTaskArgs,
    requestId: string,
    traceId: string
  ): Promise<CreateTaskResult> {
    this.logger.debug(
      'Creating new task',
      {
        requestId,
        traceId,
        task_name: args.task_name,
        task_type: args.task_type || 'project',
      },
      'CreateTaskTool'
    );

    const pool = await this.connectionManager.getPool();

    // Build the INSERT query
    const insertQuery = `
      INSERT INTO documents.tasks (
        task_name,
        task_description,
        parent_id,
        user_id,
        project_id,
        task_type,
        task_priority,
        task_prompt,
        task_status,
        file_path,
        session_id,
        reference_data,
        callback_config
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) RETURNING 
        task_id,
        task_name,
        task_description,
        task_type,
        task_priority,
        task_status,
        project_id,
        user_id,
        created_at,
        parent_id,
        session_id
    `;

    const values = [
      args.task_name,
      args.task_description,
      args.parent_id,
      args.user_id,
      args.project_id,
      args.task_type || 'project',
      args.task_priority || 25,
      args.task_prompt || null,
      args.task_status || 'pending',
      args.file_path || null,
      args.session_id || null,
      args.reference_data ? JSON.stringify(args.reference_data) : '{}',
      args.callback_config ? JSON.stringify(args.callback_config) : null,
    ];

    // Query validation is handled by the connection manager

    const result = await pool.query(insertQuery, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create task - no rows returned');
    }

    const task = result.rows[0];

    this.logger.debug(
      'Task created successfully',
      {
        requestId,
        traceId,
        task_id: task.task_id,
        task_type: task.task_type,
      },
      'CreateTaskTool'
    );

    return {
      task_id: task.task_id,
      task_name: task.task_name,
      task_description: task.task_description,
      task_type: task.task_type,
      task_priority: task.task_priority,
      task_status: task.task_status,
      project_id: task.project_id,
      user_id: task.user_id,
      created_at: task.created_at,
      parent_id: task.parent_id,
      session_id: task.session_id,
    };
  }
}
