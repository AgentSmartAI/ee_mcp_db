# Configuration & Application Simplification Plan

## Current Issues

### 1. Configuration Scattered Everywhere

- `appName` in config.json is IGNORED
- Hardcoded `'ee-tools'` and `'ee-postgres'` throughout codebase
- Hardcoded `'./logs'` path in multiple files
- Hardcoded version `'1.0.3'` in multiple places
- Environment variables used as fallbacks everywhere
- No single source of truth

### 2. Specific Hardcoded Values Found

#### App Name (process.env.APP_NAME || 'ee-tools'/'ee-postgres')

- `/src/index.ts`: Lines 20, 30, 59, 76
- `/src/logging/StructuredLogger.ts`: Line 18
- `/src/server/EEDatabaseMCPServer.ts`: Lines 69, 96
- `/src/logging/LogReaderRegistration.ts`: Line 33
- Shell scripts: `start-mcp-server.sh`, `stop-mcp-server.sh`

#### Log Directory ('./logs')

- `/src/server/EEDatabaseMCPServer.ts`: Line 66
- `/src/logging/LogReaderRegistration.ts`: Line 34
- `/src/index.ts`: Lines 17, 60
- `/src/config/ConfigurationManager.ts`: Lines 100, 148

#### Version ('1.0.3')

- `/src/logging/LogReaderRegistration.ts`: Line 35
- `/src/index.ts`: Line 61
- `package.json`: Line 3

## Proposed Solution

### 1. Enhanced Configuration Structure

```json
{
  "app": {
    "name": "ee-postgres",
    "displayName": "EE PostgreSQL MCP Server",
    "version": "auto"  // Read from package.json
  },
  "server": {
    "port": 8102,
    "cors": {
      "enabled": true,
      "origins": ["*"]
    },
    "auth": {
      "enabled": false,
      "apiKey": "PROJ-AUS1-000003"
    }
  },
  "database": {
    "host": "172.21.89.238",
    "port": 5432,
    "database": "documents",
    "schema": "documents",
    "user": "postgres",
    "password": "dasvick01!!"
  },
  "logging": {
    "level": "INFO",
    "directory": "./logs",
    "maxFiles": 7,
    "maxSize": "20m"
  }
}
```

### 2. ConfigurationManager Enhancement

```typescript
export class ConfigurationManager {
  private appConfig: {
    name: string;
    displayName: string;
    version: string;
  };
  
  constructor() {
    // Load config.json
    // Read version from package.json
    // Validate everything
  }
  
  // Typed getters for everything
  getAppName(): string { return this.appConfig.name; }
  getDisplayName(): string { return this.appConfig.displayName; }
  getVersion(): string { return this.appConfig.version; }
  getLogDirectory(): string { return this.config.logging.directory; }
  getLogLevel(): LogLevel { return this.config.logging.level; }
  getServerPort(): number { return this.config.server.port; }
  
  // Service name builder
  getServiceName(component?: string): string {
    return component ? `${this.appConfig.name}-${component}` : this.appConfig.name;
  }
}
```

### 3. Configuration Flow

```
config.json
    ↓
ConfigurationManager (singleton)
    ↓
All Components use config.getXXX()
```

### 4. Specific File Changes

#### `/src/index.ts`

```typescript
// Before
const startupLogger = new StructuredLogger({
  service: process.env.APP_NAME ? `${process.env.APP_NAME}-startup` : 'ee-tools-startup',
  directory: process.env.LOG_DIR || './logs',
  // ...
});

// After
const config = ConfigurationManager.getInstance();
const startupLogger = new StructuredLogger({
  service: config.getServiceName('startup'),
  directory: config.getLogDirectory(),
  // ...
});
```

#### `/src/server/EEDatabaseMCPServer.ts`

```typescript
// Before
this.logger = new StructuredLogger({
  service: process.env.APP_NAME || 'ee-tools',
  directory: './logs',
  // ...
});

// After
this.logger = new StructuredLogger({
  service: this.config.getServiceName(),
  directory: this.config.getLogDirectory(),
  // ...
});
```

### 5. OAuth Simplification Options

#### Option A: Remove OAuth Completely

- Delete 300+ lines of OAuth code
- Use simple Bearer token authentication
- Much simpler, works with auth disabled

#### Option B: Move OAuth to Separate Module

- Create `oauth.ts` module
- Only load if `auth.enabled = true`
- Keeps main code clean

#### Option C: Simplify Current OAuth

- Remove unused grant types
- Remove dynamic client registration
- Keep only what Claude actually uses

### 6. Implementation Steps

1. **Phase 1: ConfigurationManager Enhancement**
   - Add app section to config.json
   - Read version from package.json
   - Add all getter methods
   - Make ConfigurationManager a singleton

2. **Phase 2: Replace Hardcoded Values**
   - Replace all `process.env.APP_NAME || 'ee-tools'` with `config.getAppName()`
   - Replace all `'./logs'` with `config.getLogDirectory()`
   - Replace all `'1.0.3'` with `config.getVersion()`
   - Update shell scripts to read from config.json

3. **Phase 3: Remove Environment Variable Fallbacks**
   - Keep only DB_PASSWORD as env var
   - Remove all other process.env checks
   - Single source of truth: config.json

4. **Phase 4: OAuth Decision**
   - Decide on OAuth approach
   - Implement chosen solution
   - Test with Claude

### 7. Benefits

- **Single source of truth**: Change anything in ONE place
- **Type safety**: All config access is typed
- **No more searching**: Want to change app name? Just edit config.json
- **Cleaner code**: No more `|| 'default'` everywhere
- **Easier testing**: Mock one config object
- **Better maintainability**: New developers can understand config instantly

### 8. Files to Modify

1. `/src/config/ConfigurationManager.ts` - Enhance with app config
2. `/src/index.ts` - Use config getters
3. `/src/server/EEDatabaseMCPServer.ts` - Use config getters
4. `/src/logging/StructuredLogger.ts` - Use config getters
5. `/src/logging/LogReaderRegistration.ts` - Use config getters
6. `/start-mcp-server.sh` - Read from config.json
7. `/stop-mcp-server.sh` - Read from config.json
8. `/config.json` - Add app section

### 9. Estimated Impact

- **Lines removed**: ~200-300 (duplicate config logic)
- **Complexity reduction**: 40% simpler configuration
- **Maintenance time**: 80% faster to change configs
- **Bug reduction**: Eliminate config mismatch bugs

## Next Steps

1. Review and approve this plan
2. Create feature branch: `refactor/centralize-configuration`
3. Implement Phase 1-4
4. Test thoroughly
5. Update documentation
6. Merge to main
