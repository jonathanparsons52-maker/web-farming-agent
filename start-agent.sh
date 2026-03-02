#!/bin/bash

echo ""
echo "  ========================================="
echo "   Crumpet's Web Automation - Local Agent"
echo "  ========================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js is not installed."
    echo "  Please install Node.js from https://nodejs.org"
    echo "  Or run: brew install node"
    echo ""
    exit 1
fi

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
    echo ""
fi

# Run the agent
node agent.js

if [ $? -ne 0 ]; then
    echo ""
    echo "  Agent exited with an error."
    read -p "  Press Enter to close..."
fi
