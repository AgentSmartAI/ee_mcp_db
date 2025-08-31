/**
 * Tool for creating new jobs in the system.
 * Supports session, project, and user scope types with comprehensive job creation.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, MCPError } from '../types/index.js';

export interface CreateJobArgs {
  job_name: string;
  job_type: 'session' | 'project' | 'user';
  job_description?: string;
  project_id: string;
  company_id?: string;
  parent_job_id?: string;
  source_job_id?: string;
  job_status?: string;
  job_context?: Record<string, any>;
  reference_data?: Record<string, any>;
  callback_config?: Record<string, any>;
  created_by?: string;
}

export interface CreateJobResult {
  job_id: string;
  job_name: string;
  job_type: string;
  job_status: string;
  job_description?: string;
  project_id: string;
  company_id?: string;
  created_at: string;
  created_by?: string;
  parent_job_id?: string;
  source_job_id?: string;
}

export class CreateJobTool implements MCPTool<CreateJobArgs> {
  name = 'create_job';
  description =
    'Create a new job with session, project, or user scope. Supports comprehensive job configuration including context, callbacks, and hierarchical job structures.';

  inputSchema = {
    type: 'object',
    properties: {
      job_name: {
        type: 'string',
        description: 'Name/title of the job (required)',
      },
      job_type: {
        type: 'string',
        enum: ['session', 'project', 'user'],
        description: 'Job scope type (required)',
      },
      job_description: {
        type: 'string',
        description: 'Detailed description of the job',
      },
      project_id: {
        type: 'string',
        description: 'Project ID this job belongs to (required)',
      },
      company_id: {
        type: 'string',
        description: 'Company ID this job belongs to',
      },
      parent_job_id: {
        type: 'string',
        description: 'Parent job ID for nested jobs',
      },
      source_job_id: {
        type: 'string',
        description: 'Source job ID if this is derived from another job',
      },
      job_status: {
        type: 'string',
        description: 'Initial job status (default: queued)',
        default: 'queued',
      },
      job_context: {
        type: 'object',
        description: 'Job execution context as JSON',
      },
      reference_data: {
        type: 'object',
        description: 'Additional JSON data for job reference',
      },
      callback_config: {
        type: 'object',
        description: 'Configuration for job completion callbacks',
      },
      created_by: {
        type: 'string',
        description: 'User ID who created this job',
      },
    },
    required: ['job_name', 'job_type', 'project_id'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private queryValidator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector
  ) {}

  async execute(args: CreateJobArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const traceId =
      context?.traceId || `create_job_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    this.logger.info(
      'CreateJob request received',
      {
        requestId,
        traceId,
        job_name: args.job_name,
        job_type: args.job_type,
        project_id: args.project_id,
      },
      'CreateJobTool'
    );

    try {
      const result = await Promise.race([
        this.createJob(args, requestId, traceId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CreateJob operation timed out')), 30000)
        ),
      ]);

      const duration = Date.now() - startTime;

      this.logger.info(
        'CreateJob completed successfully',
        {
          requestId,
          traceId,
          duration,
          job_id: result.job_id,
          job_type: result.job_type,
        },
        'CreateJobTool'
      );

      // Emit success event
      if (this.eventCollector) {
        const event = createEvent(EventType.JOB_CREATED, {
          requestId,
          traceId,
          job_id: result.job_id,
          job_name: result.job_name,
          job_type: result.job_type,
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
          job_id: result.job_id,
          job_type: result.job_type,
          created_at: result.created_at,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error('CreateJob failed', error as Error, 'CreateJobTool');

      // Emit error event
      if (this.eventCollector) {
        const event = createEvent(EventType.ERROR_DETECTED, {
          requestId,
          traceId,
          tool: 'create_job',
          error: errorMessage,
          duration,
        });
        this.eventCollector.collect(event);
      }

      const enhancedError = new Error(`Failed to create job: ${errorMessage}`);
      (enhancedError as any).code = 'INTERNAL_ERROR';
      throw enhancedError;
    }
  }

  private async createJob(
    args: CreateJobArgs,
    requestId: string,
    traceId: string
  ): Promise<CreateJobResult> {
    this.logger.debug(
      'Creating new job',
      {
        requestId,
        traceId,
        job_name: args.job_name,
        job_type: args.job_type,
      },
      'CreateJobTool'
    );

    const pool = await this.connectionManager.getPool();

    // Build the INSERT query
    const insertQuery = `
      INSERT INTO documents.jobs (
        job_name,
        job_type,
        job_description,
        project_id,
        company_id,
        parent_job_id,
        source_job_id,
        job_status,
        job_context,
        reference_data,
        callback_config,
        created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) RETURNING 
        job_id,
        job_name,
        job_type,
        job_status,
        job_description,
        project_id,
        company_id,
        created_at,
        created_by,
        parent_job_id,
        source_job_id
    `;

    const values = [
      args.job_name,
      args.job_type,
      args.job_description || null,
      args.project_id,
      args.company_id || null,
      args.parent_job_id || null,
      args.source_job_id || null,
      args.job_status || 'queued',
      args.job_context ? JSON.stringify(args.job_context) : null,
      args.reference_data ? JSON.stringify(args.reference_data) : '{}',
      args.callback_config ? JSON.stringify(args.callback_config) : null,
      args.created_by || null,
    ];

    // Query validation is handled by the connection manager

    const result = await pool.query(insertQuery, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create job - no rows returned');
    }

    const job = result.rows[0];

    this.logger.debug(
      'Job created successfully',
      {
        requestId,
        traceId,
        job_id: job.job_id,
        job_type: job.job_type,
      },
      'CreateJobTool'
    );

    return {
      job_id: job.job_id,
      job_name: job.job_name,
      job_type: job.job_type,
      job_status: job.job_status,
      job_description: job.job_description,
      project_id: job.project_id,
      company_id: job.company_id,
      created_at: job.created_at,
      created_by: job.created_by,
      parent_job_id: job.parent_job_id,
      source_job_id: job.source_job_id,
    };
  }
}
