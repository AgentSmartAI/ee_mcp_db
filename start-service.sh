#!/bin/bash

# MCP Database Server Startup Script
# This script checks if the MCP server is already running on its configured port and starts it if not
# Usage: ./start-mcp-server.sh [--debug]

# Enable debug mode if requested
DEBUG=false
if [[ "$1" == "--debug" ]]; then
    DEBUG=true
fi

# Get configuration from config.json if it exists
CONFIG_FILE="$(dirname "$0")/config.json"
if [ -f "$CONFIG_FILE" ]; then
    # Extract port from server section
    PORT=$(grep -A10 '"server"' "$CONFIG_FILE" | grep -o '"port":[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
    PORT=${PORT:-8102}
    
    # Extract app name and display name
    APP_NAME=$(grep -A5 '"app"' "$CONFIG_FILE" | grep '"name"' | cut -d'"' -f4)
    APP_DISPLAY_NAME=$(grep -A5 '"app"' "$CONFIG_FILE" | grep '"displayName"' | cut -d'"' -f4)
    
    APP_NAME=${APP_NAME:-ee-postgres}
    SERVER_NAME="${APP_DISPLAY_NAME:-${APP_NAME} MCP Server}"
else
    PORT=${MCP_PORT:-8102}
    APP_NAME=${APP_NAME:-ee-postgres}
    SERVER_NAME="${APP_NAME} MCP Server"
fi

# Function to check if port is in use
is_port_in_use() {
    local port=$1
    
    # Try ss first (modern replacement for netstat)
    if command -v ss &>/dev/null; then
        ss -tln 2>/dev/null | grep -q ":${port}\b" && return 0
    fi
    
    # Try lsof as fallback
    if command -v lsof &>/dev/null; then
        lsof -i :${port} -sTCP:LISTEN &>/dev/null && return 0
    fi
    
    # If neither tool is available, check if we can connect to the port
    (echo >/dev/tcp/localhost/${port}) &>/dev/null && return 0
    
    return 1
}

# Function to check if MCP server process is already running
is_mcp_server_running() {
    # Check for processes running from this directory
    local script_dir="$(cd "$(dirname "$0")" && pwd)"
    # Check for any node process running our src/index.ts
    if pgrep -f "node.*src/index.ts" &>/dev/null; then
        # Verify it's actually from our directory
        local procs=$(pgrep -af "node.*src/index.ts" | grep -v grep)
        if echo "$procs" | grep -q "$script_dir"; then
            return 0
        fi
    fi
    return 1
}

# Check if the server is already running
if is_port_in_use $PORT || is_mcp_server_running; then
    echo "$SERVER_NAME is already running on port $PORT"
    if [[ "$DEBUG" == "true" ]]; then
        echo "Debug: Port check result: $(is_port_in_use $PORT && echo "in use" || echo "free")"
        echo "Debug: Process check result: $(is_mcp_server_running && echo "found" || echo "not found")"
        echo "Debug: MCP processes:"
        pgrep -af "node.*src/index.ts" | grep -v grep || echo "  None found"
    fi
    exit 0
else
    echo "Starting $SERVER_NAME on port $PORT..."
    cd "$(dirname "$0")"
    
    # Create logs directory if it doesn't exist
    mkdir -p logs
    
    # Start the server in the background using setsid to detach from terminal
    setsid npm start > logs/mcp-server.log 2>&1 < /dev/null &
    
    # Get the PID of the last background process
    PID=$!
    
    # Save PID to file for later use
    echo $PID > logs/mcp-server.pid
    
    # Wait a moment for the server to start
    sleep 5
    
    # Check if the process started and port is now in use
    if ps -p $PID > /dev/null && is_port_in_use $PORT; then
        echo "$SERVER_NAME started successfully (PID: $PID)"
        echo "Server is listening on port $PORT"
        echo "Logs are being written to logs/mcp-server.log"
    else
        echo "Failed to start $SERVER_NAME"
        echo "Check logs/mcp-server.log for details"
        exit 1
    fi
fi