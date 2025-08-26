#!/bin/bash

# MCP Database Server Stop Script
# This script stops the MCP server running on the configured port
# Usage: ./stop-mcp-server.sh [--debug] [--force]

# Parse command line arguments
DEBUG=false
FORCE=false
for arg in "$@"; do
    case $arg in
        --debug)
            DEBUG=true
            ;;
        --force)
            FORCE=true
            ;;
    esac
done

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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# Function to find MCP server processes
find_mcp_server_pids() {
    local pids=""
    
    # Method 0: Check PID file first
    if [ -f "$SCRIPT_DIR/logs/mcp-server.pid" ]; then
        local saved_pid=$(cat "$SCRIPT_DIR/logs/mcp-server.pid" 2>/dev/null)
        if [ -n "$saved_pid" ] && kill -0 "$saved_pid" 2>/dev/null; then
            # Verify this PID is actually our server
            if ps -p "$saved_pid" -o cmd --no-headers 2>/dev/null | grep -q "src/index.ts"; then
                pids="$saved_pid"
            fi
        fi
    fi
    
    # Method 1: Find processes that match BOTH port AND script criteria
    if command -v lsof &>/dev/null; then
        # Get all processes listening on our port
        local port_pids=$(lsof -ti tcp:${PORT} 2>/dev/null)
        
        # For each process on the port, check if it's running our script
        for pid in $port_pids; do
            if ps -p "$pid" -o cmd --no-headers 2>/dev/null | grep -q "src/index.ts"; then
                if [ -n "$pids" ]; then
                    pids="$pids $pid"
                else
                    pids="$pid"
                fi
            fi
        done
    fi
    
    # Method 2: Double-check by finding our script and verifying it uses the port
    # Find processes running our exact script
    local script_pids=$(pgrep -af "src/index.ts" | awk '{print $1}')
    
    # For each script process, verify it's using our port
    for pid in $script_pids; do
        if command -v lsof &>/dev/null; then
            if lsof -p "$pid" 2>/dev/null | grep -q ":${PORT}"; then
                # This process is running our script AND using our port
                if ! echo "$pids" | grep -q "$pid"; then
                    if [ -n "$pids" ]; then
                        pids="$pids $pid"
                    else
                        pids="$pid"
                    fi
                fi
            fi
        fi
    done
    
    echo "$pids" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

# Main script
echo "Stopping $SERVER_NAME on port $PORT..."

# Find all related processes
PIDS=$(find_mcp_server_pids)

if [ -z "$PIDS" ]; then
    if is_port_in_use $PORT; then
        echo "Warning: Port $PORT is in use but no MCP server process found"
        echo "Another application might be using this port"
    else
        echo "No $SERVER_NAME process found"
    fi
    exit 0
fi

# Count and display processes
PID_COUNT=$(echo "$PIDS" | wc -l)
echo "Found $PID_COUNT process(es) to stop: $(echo $PIDS | tr '\n' ' ')"

if [[ "$DEBUG" == "true" ]]; then
    echo "Debug: Process details:"
    for PID in $PIDS; do
        ps -p $PID -o pid,cmd 2>/dev/null | tail -n +2 || echo "  PID $PID: (no longer exists)"
    done
fi

# Terminate processes gracefully
echo "Sending SIGTERM to processes..."
for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
        kill -TERM "$PID" 2>/dev/null && echo "  Terminated process $PID" || echo "  Process $PID already gone"
    fi
done

# Wait for graceful shutdown
if [[ "$FORCE" != "true" ]]; then
    echo "Waiting for graceful shutdown..."
    sleep 3
else
    sleep 1
fi

# Check if any processes are still running and force kill if necessary
REMAINING=0
for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
        echo "Process $PID still running, sending SIGKILL..."
        kill -KILL "$PID" 2>/dev/null && echo "  Force killed process $PID" || echo "  Process $PID already gone"
        ((REMAINING++))
    fi
done

# Final verification
sleep 1
if is_port_in_use $PORT; then
    echo "Warning: Port $PORT is still in use after stopping MCP server"
    if [[ "$DEBUG" == "true" ]]; then
        echo "Debug: Processes still using port $PORT:"
        lsof -i :$PORT 2>/dev/null || echo "  Unable to list processes"
    fi
    exit 1
else
    echo "$SERVER_NAME stopped successfully"
    
    # Clean up PID file
    if [ -f "$SCRIPT_DIR/logs/mcp-server.pid" ]; then
        rm -f "$SCRIPT_DIR/logs/mcp-server.pid"
    fi
    
    if [ -f "${SCRIPT_DIR}/logs/mcp-server.log" ]; then
        echo "Server logs are available at: ${SCRIPT_DIR}/logs/mcp-server.log"
    fi
fi