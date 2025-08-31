#!/bin/bash

# Debezium PostgreSQL Connector Management Script

CONNECT_HOST="${CONNECT_HOST:-localhost}"
CONNECT_PORT="${CONNECT_PORT:-8083}"
CONNECTOR_NAME="postgres-cdc-connector"
CONFIG_FILE="postgres-cdc-connector.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if Kafka Connect is running
check_connect() {
    echo "Checking Kafka Connect status..."
    if curl -s -o /dev/null -w "%{http_code}" http://${CONNECT_HOST}:${CONNECT_PORT}/ | grep -q "200"; then
        echo -e "${GREEN}✓ Kafka Connect is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Kafka Connect is not reachable at http://${CONNECT_HOST}:${CONNECT_PORT}${NC}"
        return 1
    fi
}

# Function to list all connectors
list_connectors() {
    echo "Listing all connectors..."
    curl -s http://${CONNECT_HOST}:${CONNECT_PORT}/connectors | jq .
}

# Function to create the connector
create_connector() {
    echo "Creating PostgreSQL CDC connector..."
    
    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${RED}Error: Configuration file $CONFIG_FILE not found${NC}"
        exit 1
    fi
    
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -d @"$CONFIG_FILE" \
        http://${CONNECT_HOST}:${CONNECT_PORT}/connectors)
    
    if [ "$response" = "201" ]; then
        echo -e "${GREEN}✓ Connector created successfully${NC}"
        sleep 2
        get_status
    elif [ "$response" = "409" ]; then
        echo -e "${YELLOW}! Connector already exists${NC}"
        get_status
    else
        echo -e "${RED}✗ Failed to create connector (HTTP $response)${NC}"
        # Get error details
        curl -s -X POST \
            -H "Content-Type: application/json" \
            -d @"$CONFIG_FILE" \
            http://${CONNECT_HOST}:${CONNECT_PORT}/connectors | jq .
    fi
}

# Function to get connector status
get_status() {
    echo "Getting connector status..."
    status=$(curl -s http://${CONNECT_HOST}:${CONNECT_PORT}/connectors/${CONNECTOR_NAME}/status | jq .)
    
    if [ -z "$status" ]; then
        echo -e "${RED}Connector not found${NC}"
        return 1
    fi
    
    echo "$status"
    
    # Check if connector is running
    state=$(echo "$status" | jq -r '.connector.state')
    if [ "$state" = "RUNNING" ]; then
        echo -e "${GREEN}✓ Connector is RUNNING${NC}"
    else
        echo -e "${RED}✗ Connector state: $state${NC}"
    fi
}

# Function to delete the connector
delete_connector() {
    echo "Deleting connector..."
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X DELETE \
        http://${CONNECT_HOST}:${CONNECT_PORT}/connectors/${CONNECTOR_NAME})
    
    if [ "$response" = "204" ]; then
        echo -e "${GREEN}✓ Connector deleted successfully${NC}"
    else
        echo -e "${RED}✗ Failed to delete connector (HTTP $response)${NC}"
    fi
}

# Function to restart the connector
restart_connector() {
    echo "Restarting connector..."
    curl -s -X POST http://${CONNECT_HOST}:${CONNECT_PORT}/connectors/${CONNECTOR_NAME}/restart
    echo -e "${GREEN}✓ Restart command sent${NC}"
    sleep 2
    get_status
}

# Function to update connector configuration
update_connector() {
    echo "Updating connector configuration..."
    
    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${RED}Error: Configuration file $CONFIG_FILE not found${NC}"
        exit 1
    fi
    
    # Extract just the config part from the JSON file
    config=$(jq '.config' "$CONFIG_FILE")
    
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PUT \
        -H "Content-Type: application/json" \
        -d "$config" \
        http://${CONNECT_HOST}:${CONNECT_PORT}/connectors/${CONNECTOR_NAME}/config)
    
    if [ "$response" = "200" ]; then
        echo -e "${GREEN}✓ Connector updated successfully${NC}"
        sleep 2
        get_status
    else
        echo -e "${RED}✗ Failed to update connector (HTTP $response)${NC}"
    fi
}

# Function to view connector tasks
get_tasks() {
    echo "Getting connector tasks..."
    curl -s http://${CONNECT_HOST}:${CONNECT_PORT}/connectors/${CONNECTOR_NAME}/tasks | jq .
}

# Function to view topics created by the connector
list_topics() {
    echo "Topics that will be created by this connector:"
    echo "- cdc.documents.* (one topic per table)"
    echo "- schema-changes.documents (schema history)"
    echo ""
    echo "After transformation:"
    echo "- postgres.documents.* (final topic names)"
}

# Main menu
case "${1}" in
    "create")
        check_connect && create_connector
        ;;
    "status")
        check_connect && get_status
        ;;
    "delete")
        check_connect && delete_connector
        ;;
    "restart")
        check_connect && restart_connector
        ;;
    "update")
        check_connect && update_connector
        ;;
    "list")
        check_connect && list_connectors
        ;;
    "tasks")
        check_connect && get_tasks
        ;;
    "topics")
        list_topics
        ;;
    *)
        echo "PostgreSQL CDC Connector Management"
        echo ""
        echo "Usage: $0 {create|status|delete|restart|update|list|tasks|topics}"
        echo ""
        echo "Commands:"
        echo "  create  - Create the PostgreSQL CDC connector"
        echo "  status  - Check connector status"
        echo "  delete  - Delete the connector"
        echo "  restart - Restart the connector"
        echo "  update  - Update connector configuration"
        echo "  list    - List all connectors"
        echo "  tasks   - View connector tasks"
        echo "  topics  - List topics that will be created"
        echo ""
        echo "Environment variables:"
        echo "  CONNECT_HOST - Kafka Connect host (default: localhost)"
        echo "  CONNECT_PORT - Kafka Connect port (default: 8083)"
        ;;
esac