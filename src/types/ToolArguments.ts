/**
 * Type-safe interfaces for all tool arguments
 */

// Query Tool Arguments
export interface QueryExecutorArgs {
  sql: string;
  params?: Array<string | number | boolean | null>;
  options?: {
    timeout?: number;
    maxRows?: number;
  };
}

// Batch Query Tool Arguments
export interface BatchQueryArgs {
  queries: Array<{
    sql: string;
    params?: Array<string | number | boolean | null>;
    name?: string;
  }>;
  options?: {
    transaction?: boolean;
    stopOnError?: boolean;
    timeout?: number;
    maxParallel?: number;
  };
}

// Schema Explorer Arguments
export interface SchemaExplorerArgs {
  search?: string;
}

// Table Inspector Arguments
export interface TableInspectorArgs {
  table_name: string;
  include_stats?: boolean;
}

// Database Catalog Arguments
export interface DatabaseCatalogArgs {
  // No arguments required
}

// Create Managed Table Arguments
export interface CreateManagedTableArgs {
  table_name: string;
  id_prefix: string;
  additional_columns?: string;
}

// Get Tasks Arguments
export interface GetTasksArgs {
  project_id?: string;
  job_id?: string;
  user_id?: string;
  inc_bugs?: boolean;
  search_string?: string;
  module_name?: string;
}

// Create Task Arguments
export interface CreateTaskArgs {
  task_name: string;
  task_description: string;
  parent_id: string;
  user_id: string;
  project_id: string;
  task_type?: 'session' | 'project' | 'user';
  task_priority?: number;
  task_prompt?: string;
  task_status?: string;
  file_path?: string;
  parent_task_id?: string;
  session_id?: string;
  reference_data?: Record<string, any>;
  callback_config?: Record<string, any>;
}

// Create Job Arguments
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

// Help Tool Arguments
export interface HelpArgs {
  topic?: 'tools' | 'query' | 'schema' | 'errors' | 'parameters';
}

// Union type for all tool arguments
export type ToolArguments =
  | QueryExecutorArgs
  | BatchQueryArgs
  | SchemaExplorerArgs
  | TableInspectorArgs
  | DatabaseCatalogArgs
  | CreateManagedTableArgs
  | GetTasksArgs
  | CreateTaskArgs
  | CreateJobArgs
  | HelpArgs;
