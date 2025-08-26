# MCP EE-Tools Database Server Makefile

# Default target
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  make install          - Install dependencies"
	@echo "  make build           - Build TypeScript to JavaScript"
	@echo "  make dev             - Start development server with auto-reload"
	@echo "  make start           - Start production server"
	@echo "  make test            - Run all tests"
	@echo "  make test-mcp        - Run MCP integration tests"
	@echo "  make clean           - Clean build artifacts"
	@echo "  make lint            - Run linting checks"
	@echo "  make format          - Format code with Prettier"
	@echo "  make check-all       - Run all checks (type, lint, format)"

# Installation
.PHONY: install
install:
	npm install

# Build
.PHONY: build
build:
	npm run build

.PHONY: clean
clean:
	npm run clean

# Development
.PHONY: dev
dev:
	npm run dev

.PHONY: start
start:
	npm start

# Code Quality
.PHONY: lint
lint:
	npm run lint

.PHONY: lint-fix
lint-fix:
	npm run lint:fix

.PHONY: format
format:
	npm run format

.PHONY: format-check
format-check:
	npm run format:check

.PHONY: typecheck
typecheck:
	npm run typecheck

.PHONY: check-all
check-all:
	npm run check:all

# Testing - General
.PHONY: test
test: test-unit test-integration test-mcp

.PHONY: test-unit
test-unit:
	@echo "Running unit tests..."
	npm run test:unit

.PHONY: test-integration
test-integration:
	@echo "Running integration tests..."
	npm run test:integration

.PHONY: test-e2e
test-e2e:
	@echo "Running end-to-end tests..."
	npm run test:e2e

.PHONY: test-coverage
test-coverage:
	@echo "Running tests with coverage..."
	npm run test:coverage

.PHONY: test-watch
test-watch:
	@echo "Running tests in watch mode..."
	npm run test:watch

# MCP Server Tests
.PHONY: test-mcp
test-mcp: test-mcp-connection test-mcp-queries test-mcp-errors test-mcp-batch test-mcp-schema

.PHONY: test-mcp-quick
test-mcp-quick: test-mcp-connection test-mcp-queries test-mcp-errors

.PHONY: test-mcp-full
test-mcp-full:
	@echo "Running full MCP test suite..."
	npm run test -- tests/mcp/ee-tools/

.PHONY: test-mcp-connection
test-mcp-connection:
	@echo "Testing MCP server connection..."
	npm run test -- tests/mcp/ee-tools/test-connection.spec.ts

.PHONY: test-mcp-queries
test-mcp-queries:
	@echo "Testing MCP query operations..."
	npm run test -- tests/mcp/ee-tools/test-queries.spec.ts

.PHONY: test-mcp-batch
test-mcp-batch:
	@echo "Testing MCP batch queries..."
	npm run test -- tests/mcp/ee-tools/test-batch-queries.spec.ts

.PHONY: test-mcp-errors
test-mcp-errors:
	@echo "Testing MCP error handling..."
	npm run test -- tests/mcp/ee-tools/test-error-handling.spec.ts

.PHONY: test-mcp-schema
test-mcp-schema:
	@echo "Testing MCP schema tools..."
	npm run test -- tests/mcp/ee-tools/test-schema-tools.spec.ts

.PHONY: test-mcp-filesystem
test-mcp-filesystem:
	@echo "Testing MCP filesystem operations..."
	npm run test -- tests/mcp/ee-tools/test-filesystem.spec.ts

.PHONY: test-mcp-thinking
test-mcp-thinking:
	@echo "Testing MCP sequential thinking tool..."
	npm run test -- tests/mcp/ee-tools/test-sequential-thinking.spec.ts

# Server Management
.PHONY: server-start
server-start:
	./start-mcp-server.sh

.PHONY: server-stop
server-stop:
	./stop-mcp-server.sh

.PHONY: server-restart
server-restart: server-stop server-start

.PHONY: server-logs
server-logs:
	tail -f logs/mcp-server.log

# Database Operations (requires running server)
.PHONY: db-test-connection
db-test-connection:
	@echo "Testing database connection..."
	@curl -s -X POST http://localhost:3000/rpc \
		-H "Content-Type: application/json" \
		-d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_databases","arguments":{}},"id":1}' | jq

# Continuous Integration
.PHONY: ci
ci: clean install build check-all test

.PHONY: ci-mcp
ci-mcp: build test-mcp

# Development Helpers
.PHONY: watch
watch:
	npm run dev

.PHONY: logs
logs:
	@echo "=== Recent MCP Server Logs ==="
	@tail -n 50 logs/ee-tools-*.jsonl | jq -r '[.timestamp, .level, .message] | @tsv' 2>/dev/null || echo "No logs found"

.PHONY: logs-errors
logs-errors:
	@echo "=== Recent Errors ==="
	@grep -h '"level":"error"' logs/ee-tools-*.jsonl 2>/dev/null | tail -n 20 | jq || echo "No errors found"

.PHONY: logs-startup
logs-startup:
	@echo "=== Recent Startup Logs ==="
	@tail -n 20 logs/ee-tools-startup-*.jsonl | jq 2>/dev/null || echo "No startup logs found"

# Utility targets
.PHONY: deps-check
deps-check:
	npm run deps:check

.PHONY: unused
unused:
	npm run unused

.PHONY: circular
circular:
	npm run circular

.PHONY: knip
knip:
	npm run knip

# Documentation
.PHONY: docs
docs:
	@echo "Opening documentation..."
	@open README.md || xdg-open README.md 2>/dev/null || echo "Please open README.md manually"

# Environment setup
.PHONY: env-check
env-check:
	@echo "Checking environment variables..."
	@test -n "$$DATABASE_URL" || (echo "ERROR: DATABASE_URL not set" && exit 1)
	@echo "DATABASE_URL is set"
	@test -n "$$NODE_ENV" && echo "NODE_ENV: $$NODE_ENV" || echo "NODE_ENV: not set (defaults to development)"
	@test -n "$$LOG_LEVEL" && echo "LOG_LEVEL: $$LOG_LEVEL" || echo "LOG_LEVEL: not set (defaults to info)"

.PHONY: env-test
env-test:
	@echo "Setting up test environment..."
	@export NODE_ENV=test && export LOG_LEVEL=error && $(MAKE) test-mcp

# Default database URL for local development
export DATABASE_URL ?= postgresql://postgres:postgres@localhost:5432/documents

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[0;33m
BLUE := \033[0;34m
NC := \033[0m # No Color

# Pretty printing helpers
define print_header
	@echo "$(BLUE)=== $(1) ===$(NC)"
endef

define print_success
	@echo "$(GREEN)✓ $(1)$(NC)"
endef

define print_error
	@echo "$(RED)✗ $(1)$(NC)"
endef

define print_warning
	@echo "$(YELLOW)⚠ $(1)$(NC)"
endef