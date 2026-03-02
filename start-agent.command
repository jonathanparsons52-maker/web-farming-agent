#!/bin/bash

echo ""
echo "  ========================================="
echo "   Crumpet's Web Automation - Local Agent"
echo "  ========================================="
echo ""

# Get the directory where this script lives
cd "$(dirname "$0")"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js is not installed."
    echo "  Please install Node.js from https://nodejs.org"
    echo ""
    read -p "  Press Enter to close..."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
    echo ""
fi

# Run the agent
node agent.js

echo ""
read -p "  Press Enter to close..."
