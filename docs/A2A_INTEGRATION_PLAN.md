# A2A Integration Plan for MCP Database Server

## Overview

This document outlines the detailed plan for integrating the A2A (Agent-to-Agent) protocol into the PostgreSQL MCP server. The A2A protocol enables AI agents to discover each other, negotiate capabilities, and collaborate on complex tasks while maintaining security and privacy.

## Architecture Overview

``` text
┌─────────────────────────────────────────────────────────────────┐
│                       MCP Database Server                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐     │
│  │   Existing  │  │     A2A      │  │    A2A Protocol     │     │
│  │  MCP Tools  │  │    Tools     │  │     Transport       │     │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘     │
│         │                │                     │                │
│  ┌──────┴────────────────┴─────────────────────┴──────────┐     │
│  │              PostgresReadOnlyMCPServer                 |     │
│  └───────────────────────┬────────────────────────────────┘     │
│                          │                                      │
│  ┌───────────────────────┴───────────────────────────────────┐  │
│  │                  PostgreSQL Database                      │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ A2A Tables: agents, tasks, jobs, messages, sessions │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Phase 1: Database Schema Design

### 1.1 Create A2A Schema SQL File

Location: `/sql/a2a_schema.sql`

#### a2a_agents Table

```sql
-- Stores registered AI agents and their capabilities
CREATE TABLE IF NOT EXISTS agents (
    agent_id VARCHAR(255) PRIMARY KEY DEFAULT 'agent_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    endpoint_url VARCHAR(500) NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '{}',
    agent_card JSONB NOT NULL DEFAULT '{}', -- Full A2A agent card
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    last_heartbeat TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) DEFAULT 'system',
    modified_by VARCHAR(255) DEFAULT 'system',
    is_deleted BOOLEAN DEFAULT FALSE,
    reference_data JSONB DEFAULT '{}'
);

CREATE INDEX idx_a2a_agents_status ON a2a_agents(status) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_agents_capabilities ON a2a_agents USING gin(capabilities);
```

#### a2a_tasks Table

```sql
-- Stores tasks that can be distributed to agents
CREATE TABLE IF NOT EXISTS tasks (
    task_id VARCHAR(255) PRIMARY KEY DEFAULT 'task_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    task_type VARCHAR(100) NOT NULL,
    required_capabilities JSONB DEFAULT '[]', -- Array of required capabilities
    input_schema JSONB NOT NULL DEFAULT '{}',
    output_schema JSONB DEFAULT '{}',
    priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    max_retries INTEGER DEFAULT 3,
    timeout_seconds INTEGER DEFAULT 300,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) DEFAULT 'system',
    modified_by VARCHAR(255) DEFAULT 'system',
    is_deleted BOOLEAN DEFAULT FALSE,
    reference_data JSONB DEFAULT '{}'
);

CREATE INDEX idx_a2a_tasks_type ON a2a_tasks(task_type) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_tasks_priority ON a2a_tasks(priority DESC) WHERE NOT is_deleted;
```

#### a2a_jobs Table

```sql
-- Tracks job execution and status
CREATE TABLE IF NOT EXISTS jobs (
    job_id VARCHAR(255) PRIMARY KEY DEFAULT 'job_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    task_id VARCHAR(255) NOT NULL REFERENCES a2a_tasks(task_id),
    assigned_agent_id VARCHAR(255) REFERENCES a2a_agents(agent_id),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'running', 'completed', 'failed', 'cancelled')),
    input_data JSONB NOT NULL DEFAULT '{}',
    output_data JSONB DEFAULT '{}',
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    execution_time_ms INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) DEFAULT 'system',
    modified_by VARCHAR(255) DEFAULT 'system',
    is_deleted BOOLEAN DEFAULT FALSE,
    reference_data JSONB DEFAULT '{}'
);

CREATE INDEX idx_a2a_jobs_status ON a2a_jobs(status) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_jobs_task_id ON a2a_jobs(task_id) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_jobs_agent_id ON a2a_jobs(assigned_agent_id) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_jobs_created_at ON a2a_jobs(created_at DESC) WHERE NOT is_deleted;
```

#### a2a_messages Table

```sql
-- Stores inter-agent messages
CREATE TABLE IF NOT EXISTS messages (
    message_id VARCHAR(255) PRIMARY KEY DEFAULT 'msg_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    session_id VARCHAR(255) NOT NULL,
    sender_agent_id VARCHAR(255) REFERENCES a2a_agents(agent_id),
    receiver_agent_id VARCHAR(255) REFERENCES a2a_agents(agent_id),
    message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('request', 'response', 'notification', 'error')),
    protocol_version VARCHAR(20) DEFAULT '2.0',
    content JSONB NOT NULL, -- JSON-RPC 2.0 message content
    status VARCHAR(50) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'acknowledged', 'failed')),
    error_details JSONB,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP WITH TIME ZONE,
    acknowledged_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_a2a_messages_session ON a2a_messages(session_id);
CREATE INDEX idx_a2a_messages_sender ON a2a_messages(sender_agent_id);
CREATE INDEX idx_a2a_messages_receiver ON a2a_messages(receiver_agent_id);
CREATE INDEX idx_a2a_messages_created ON a2a_messages(created_at DESC);
```

#### a2a_sessions Table

```sql
-- Tracks active A2A sessions
CREATE TABLE IF NOT EXISTS a2a_sessions (
    session_id VARCHAR(255) PRIMARY KEY DEFAULT 'sess_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    initiator_agent_id VARCHAR(255) NOT NULL REFERENCES a2a_agents(agent_id),
    participant_agent_ids JSONB DEFAULT '[]', -- Array of participating agent IDs
    session_type VARCHAR(50) DEFAULT 'standard',
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'terminated')),
    context JSONB DEFAULT '{}', -- Shared session context
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) DEFAULT 'system',
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_a2a_sessions_status ON a2a_sessions(status) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_sessions_initiator ON a2a_sessions(initiator_agent_id) WHERE NOT is_deleted;
CREATE INDEX idx_a2a_sessions_participants ON a2a_sessions USING gin(participant_agent_ids);
```

### 1.2 Create Triggers for Updated Timestamps

```sql
-- Apply the update trigger to all A2A tables
CREATE TRIGGER update_a2a_agents_modified_at BEFORE UPDATE ON a2a_agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_a2a_tasks_modified_at BEFORE UPDATE ON a2a_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_a2a_jobs_modified_at BEFORE UPDATE ON a2a_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Phase 2: A2A Protocol Implementation

### 2.1 A2A Transport Layer

Location: `src/a2a/A2ATransport.ts`

```typescript
/**
 * A2A Transport implementation for JSON-RPC 2.0 over HTTP(S)
 * Handles agent-to-agent communication
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { EventCollector } from '../events/EventCollector.js';

export interface A2AMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: {
    methods: string[];
    protocols: string[];
    features: string[];
  };
  endpoint: string;
  metadata?: Record<string, any>;
}

export class A2ATransport extends EventEmitter {
  private messageId: number = 0;
  
  constructor(
    private logger: StructuredLogger,
    private eventCollector?: EventCollector,
    private timeout: number = 30000
  ) {
    super();
  }

  /**
   * Send a JSON-RPC 2.0 request to another agent
   */
  async sendRequest(
    endpoint: string,
    method: string,
    params: any,
    headers?: Record<string, string>
  ): Promise<any> {
    const id = ++this.messageId;
    const message: A2AMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    try {
      const response = await axios.post(endpoint, message, {
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        timeout: this.timeout
      });

      if (response.data.error) {
        throw new Error(`A2A Error: ${response.data.error.message}`);
      }

      return response.data.result;
    } catch (error) {
      this.logger.error('A2A request failed', error as Error, 'A2ATransport');
      throw error;
    }
  }

  /**
   * Handle incoming JSON-RPC 2.0 request
   */
  async handleRequest(message: A2AMessage): Promise<A2AMessage> {
    // Implementation will be added when creating the A2A server endpoint
    throw new Error('Not implemented');
  }

  /**
   * Discover agent capabilities
   */
  async discoverAgent(endpoint: string): Promise<A2AAgentCard> {
    return this.sendRequest(endpoint, 'agent.discover', {});
  }

  /**
   * Negotiate interaction mode with another agent
   */
  async negotiate(endpoint: string, proposal: any): Promise<any> {
    return this.sendRequest(endpoint, 'agent.negotiate', { proposal });
  }
}
```

### 2.2 A2A Protocol Handler

Location: `src/a2a/A2AProtocolHandler.ts`

```typescript
/**
 * Handles A2A protocol operations and message routing
 */

export class A2AProtocolHandler {
  constructor(
    private transport: A2ATransport,
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger
  ) {}

  /**
   * Register this MCP server as an A2A agent
   */
  async registerSelf(agentCard: A2AAgentCard): Promise<void> {
    // Store agent card in database
    // Implementation details...
  }

  /**
   * Handle incoming A2A requests
   */
  async handleIncomingRequest(request: A2AMessage): Promise<A2AMessage> {
    // Route to appropriate handler based on method
    // Implementation details...
  }

  /**
   * Execute task via A2A
   */
  async executeTask(taskId: string, agentId: string, input: any): Promise<any> {
    // Implementation details...
  }
}
```

## Phase 3: Tool Integration

### 3.1 A2ARegisterAgentTool

Location: `src/tools/a2a/A2ARegisterAgentTool.ts`

```typescript
export class A2ARegisterAgentTool implements MCPTool {
  name = 'a2a_register_agent';
  description = 'Register an AI agent in the A2A network';
  
  inputSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name' },
      description: { type: 'string', description: 'Agent description' },
      endpoint_url: { type: 'string', description: 'Agent endpoint URL' },
      capabilities: { type: 'object', description: 'Agent capabilities' }
    },
    required: ['name', 'endpoint_url', 'capabilities']
  };

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    // Implementation details...
  }
}
```

### 3.2 A2ADiscoverAgentsTool

Location: `src/tools/a2a/A2ADiscoverAgentsTool.ts`

```typescript
export class A2ADiscoverAgentsTool implements MCPTool {
  name = 'a2a_discover_agents';
  description = 'Discover available AI agents and their capabilities';
  
  inputSchema = {
    type: 'object',
    properties: {
      capability_filter: { 
        type: 'array', 
        description: 'Filter agents by required capabilities',
        items: { type: 'string' }
      },
      status: { 
        type: 'string', 
        description: 'Filter by agent status',
        enum: ['active', 'inactive', 'all']
      }
    }
  };

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    // Implementation details...
  }
}
```

### 3.3 A2AExecuteTaskTool

Location: `src/tools/a2a/A2AExecuteTaskTool.ts`

```typescript
export class A2AExecuteTaskTool implements MCPTool {
  name = 'a2a_execute_task';
  description = 'Execute a task via A2A protocol on a remote agent';
  
  inputSchema = {
    type: 'object',
    properties: {
      task_type: { type: 'string', description: 'Type of task to execute' },
      input_data: { type: 'object', description: 'Input data for the task' },
      agent_id: { 
        type: 'string', 
        description: 'Specific agent ID (optional, will auto-select if not provided)' 
      },
      priority: { 
        type: 'integer', 
        description: 'Task priority (1-10)',
        minimum: 1,
        maximum: 10,
        default: 5
      }
    },
    required: ['task_type', 'input_data']
  };

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    // Implementation details...
  }
}
```

### 3.4 A2AMessageTool

Location: `src/tools/a2a/A2AMessageTool.ts`

```typescript
export class A2AMessageTool implements MCPTool {
  name = 'a2a_message';
  description = 'Send a message to another agent via A2A protocol';
  
  inputSchema = {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Target agent ID' },
      message_type: { 
        type: 'string', 
        description: 'Type of message',
        enum: ['request', 'notification']
      },
      content: { type: 'object', description: 'Message content' },
      session_id: { 
        type: 'string', 
        description: 'Session ID for conversation context (optional)' 
      }
    },
    required: ['agent_id', 'message_type', 'content']
  };

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    // Implementation details...
  }
}
```

## Phase 4: Event System Integration

### 4.1 New Event Types

Add to `src/events/EventTypes.ts`:

```typescript
// A2A Events
A2A_AGENT_REGISTERED = 'A2A_AGENT_REGISTERED',
A2A_AGENT_DISCOVERED = 'A2A_AGENT_DISCOVERED',
A2A_AGENT_HEARTBEAT = 'A2A_AGENT_HEARTBEAT',
A2A_TASK_CREATED = 'A2A_TASK_CREATED',
A2A_TASK_ASSIGNED = 'A2A_TASK_ASSIGNED',
A2A_TASK_COMPLETED = 'A2A_TASK_COMPLETED',
A2A_TASK_FAILED = 'A2A_TASK_FAILED',
A2A_MESSAGE_SENT = 'A2A_MESSAGE_SENT',
A2A_MESSAGE_RECEIVED = 'A2A_MESSAGE_RECEIVED',
A2A_SESSION_STARTED = 'A2A_SESSION_STARTED',
A2A_SESSION_ENDED = 'A2A_SESSION_ENDED',
```

### 4.2 A2A Event Processor

Location: `src/events/A2AEventProcessor.ts`

```typescript
export class A2AEventProcessor implements EventProcessor {
  async process(event: MCPEvent): Promise<void> {
    // Process A2A-specific events
    // Send to Kafka for distributed processing
    // Update agent status, job progress, etc.
  }
}
```

## Phase 5: Configuration

### 5.1 A2A Configuration

Add to configuration system:

```typescript
export interface A2AConfig {
  enabled: boolean;
  agent: {
    name: string;
    description: string;
    endpoint: string;
    capabilities: string[];
  };
  transport: {
    timeout: number;
    maxRetries: number;
    retryDelay: number;
  };
  discovery: {
    refreshInterval: number;
    maxAgents: number;
  };
  security: {
    requireAuthentication: boolean;
    verifyAgents: boolean;
    trustedDomains: string[];
  };
}
```

### 5.2 Environment Variables

```bash
# A2A Configuration
A2A_ENABLED=true
A2A_AGENT_NAME="MCP Database Agent"
A2A_AGENT_DESCRIPTION="PostgreSQL database operations agent"
A2A_AGENT_ENDPOINT="https://your-domain.com/a2a"
A2A_TRANSPORT_TIMEOUT=30000
A2A_DISCOVERY_INTERVAL=300000
A2A_REQUIRE_AUTH=true
```

## Phase 6: Security Considerations

### 6.1 Agent Authentication

- Implement JWT-based authentication for A2A requests
- Store agent credentials securely
- Rotate tokens periodically

### 6.2 Message Validation

- Validate all incoming JSON-RPC messages
- Implement rate limiting per agent
- Log all A2A interactions for audit

### 6.3 Data Privacy

- Encrypt sensitive data in messages
- Implement agent-specific permissions
- Respect data retention policies

## Phase 7: Testing Strategy

### 7.1 Unit Tests

- Test each A2A tool independently
- Test transport layer with mock agents
- Test event processing

### 7.2 Integration Tests

- Test agent registration and discovery
- Test task execution flow
- Test message exchange

### 7.3 E2E Tests

- Test full A2A workflow with multiple agents
- Test error handling and recovery
- Test performance under load

## Phase 8: Monitoring and Observability

### 8.1 Metrics to Track

- Agent availability and health
- Task success/failure rates
- Message delivery times
- Session durations

### 8.2 Logging

- Log all A2A interactions with trace IDs
- Implement structured logging for A2A events
- Create A2A-specific log analysis queries

### 8.3 Alerts

- Alert on agent unavailability
- Alert on high task failure rates
- Alert on message delivery failures

## Implementation Timeline

1. **Week 1**: Database schema and basic transport
2. **Week 2**: Core A2A tools implementation
3. **Week 3**: Event integration and testing
4. **Week 4**: Security, monitoring, and documentation

## Next Steps

1. Review and approve the database schema
2. Set up A2A development environment
3. Begin implementation of Phase 1
4. Create A2A testing framework

## References

- [A2A Protocol Specification](https://github.com/a2aproject/A2A)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
