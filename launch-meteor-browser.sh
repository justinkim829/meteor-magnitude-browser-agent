#!/bin/bash

# Meteor Browser Launch Script
# 
# This script launches Chrome with secure CDP by:
# 1. Starting Chrome on a random port with CDP enabled
# 2. Starting the CDP proxy on standard port 9222
# 3. Writing connection info for Magnitude tools

set -e

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
METEOR_DIR="$HOME/.meteor"
CONFIG_FILE="$METEOR_DIR/cdp-proxy.json"
PID_FILE="$METEOR_DIR/meteor.pid"

# Ensure meteor directory exists
mkdir -p "$METEOR_DIR"

# Function to generate random port
get_random_port() {
    echo $((40000 + RANDOM % 10000))
}

# Function to generate secure token
generate_token() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]'
    else
        # Fallback to using /dev/urandom
        head -c 32 /dev/urandom | base64 | tr -d '/+=' | tr '[:upper:]' '[:lower:]' | head -c 32
    fi
}

# Check if Chrome is already running with our CDP
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Meteor Browser is already running (PID: $OLD_PID)"
        echo "Connection info is in: $CONFIG_FILE"
        exit 0
    else
        # Clean up stale PID file
        rm -f "$PID_FILE"
    fi
fi

# Generate random port and token
CDP_PORT=$(get_random_port)
CDP_TOKEN=$(generate_token)

echo "Starting Meteor Browser..."
echo "  CDP Port: $CDP_PORT (internal)"
echo "  Proxy Port: 9222 (public)"
echo "  Token: ${CDP_TOKEN:0:8}..."

# Find Chrome executable
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    if [ -x "/Users/justinkim829/Documents/meteor/chromium/src/out/Default/Chromium.app/Contents/MacOS/Chromium" ]; then
        CHROME_BIN="/Users/justinkim829/Documents/meteor/chromium/src/out/Default/Chromium.app/Contents/MacOS/Chromium"
    elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    else
        echo "Error: Chrome executable not found"
        exit 1
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if [ -x "$SCRIPT_DIR/../../../../out/Default/chrome" ]; then
        CHROME_BIN="$SCRIPT_DIR/../../../../out/Default/chrome"
    elif command -v google-chrome >/dev/null 2>&1; then
        CHROME_BIN="google-chrome"
    elif command -v chromium >/dev/null 2>&1; then
        CHROME_BIN="chromium"
    else
        echo "Error: Chrome executable not found"
        exit 1
    fi
else
    echo "Error: Unsupported OS"
    exit 1
fi

# Start Chrome with CDP on random port
echo "Starting Chrome..."
"$CHROME_BIN" \
    --remote-debugging-port=$CDP_PORT \
    --remote-debugging-address=127.0.0.1 \
    --enable-logging \
    --v=0 \
    "$@" &

CHROME_PID=$!
echo $CHROME_PID > "$PID_FILE"

# Wait for Chrome to start
echo "Waiting for Chrome to start..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
        echo "Chrome started successfully"
        break
    fi
    sleep 0.5
done

# Check if Chrome started successfully
if ! curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo "Error: Chrome failed to start CDP server"
    kill $CHROME_PID 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

# Start CDP proxy
echo "Starting CDP proxy..."
CDP_PORT=$CDP_PORT CDP_TOKEN=$CDP_TOKEN node "$SCRIPT_DIR/meteor-cdp-proxy.js" &
PROXY_PID=$!

# Wait for proxy to start
echo "Waiting for CDP proxy to start..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:9222/health" >/dev/null 2>&1; then
        echo "CDP proxy started successfully"
        break
    fi
    sleep 0.5
done

# Check if proxy started successfully
if ! curl -s "http://127.0.0.1:9222/health" >/dev/null 2>&1; then
    echo "Error: CDP proxy failed to start"
    kill $CHROME_PID 2>/dev/null || true
    kill $PROXY_PID 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

echo ""
echo "✅ Meteor Browser is running!"
echo ""
echo "CDP Access:"
echo "  URL: http://127.0.0.1:9222"
echo "  Token: $CDP_TOKEN"
echo ""
echo "For Magnitude tools, use:"
echo "  chromium.connectOverCDP('http://127.0.0.1:9222?token=$CDP_TOKEN')"
echo ""
echo "Connection info saved to: $CONFIG_FILE"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down Meteor Browser..."
    
    # Kill proxy first
    if [ ! -z "$PROXY_PID" ] && ps -p $PROXY_PID > /dev/null 2>&1; then
        kill $PROXY_PID 2>/dev/null || true
    fi
    
    # Kill Chrome
    if [ -f "$PID_FILE" ]; then
        CHROME_PID=$(cat "$PID_FILE")
        if ps -p $CHROME_PID > /dev/null 2>&1; then
            kill $CHROME_PID 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi
    
    echo "Meteor Browser stopped"
}

# Set up cleanup on script exit
trap cleanup EXIT INT TERM

# Wait for Chrome to exit
wait $CHROME_PID