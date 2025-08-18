#!/bin/bash

# Production Launch Script for Meteor Browser with Secure CDP
# 
# This script is optimized for production environments including Docker

set -e

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
METEOR_DIR="${METEOR_DIR:-$HOME/.meteor}"
CONFIG_FILE="${METEOR_CONFIG:-$METEOR_DIR/cdp-proxy.json}"
PID_FILE="${METEOR_PID:-$METEOR_DIR/meteor.pid}"
LOG_DIR="${METEOR_LOGS:-$METEOR_DIR/logs}"

# Ensure directories exist
mkdir -p "$METEOR_DIR" "$LOG_DIR"

# Function to generate random port
get_random_port() {
    # Use a higher range to avoid conflicts
    echo $((50000 + RANDOM % 10000))
}

# Function to generate secure token
generate_token() {
    # Try multiple methods for token generation
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    elif command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]' | md5sum | cut -d' ' -f1
    else
        # Fallback to /dev/urandom
        head -c 32 /dev/urandom | base64 | tr -d '/+=' | tr '[:upper:]' '[:lower:]' | head -c 32
    fi
}

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Meteor Browser is already running (PID: $OLD_PID)"
        echo "Connection info is in: $CONFIG_FILE"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# Generate random port and token
CDP_PORT="${CDP_PORT:-$(get_random_port)}"
CDP_TOKEN="${CDP_TOKEN:-$(generate_token)}"
PROXY_PORT="${PROXY_PORT:-9222}"

echo "Starting Meteor Browser (Production Mode)..."
echo "  CDP Port: $CDP_PORT (internal)"
echo "  Proxy Port: $PROXY_PORT (public)"
echo "  Token: ${CDP_TOKEN:0:8}..."
echo "  Logs: $LOG_DIR"

# Find Chrome executable
if [ -n "$CHROME_BIN" ]; then
    # Use environment variable if set (e.g., in Docker)
    echo "Using Chrome from CHROME_BIN: $CHROME_BIN"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    elif [ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
        CHROME_BIN="/Applications/Chromium.app/Contents/MacOS/Chromium"
    else
        echo "Error: Chrome executable not found on macOS"
        exit 1
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v google-chrome-stable >/dev/null 2>&1; then
        CHROME_BIN="google-chrome-stable"
    elif command -v google-chrome >/dev/null 2>&1; then
        CHROME_BIN="google-chrome"
    elif command -v chromium-browser >/dev/null 2>&1; then
        CHROME_BIN="chromium-browser"
    elif command -v chromium >/dev/null 2>&1; then
        CHROME_BIN="chromium"
    else
        echo "Error: Chrome executable not found on Linux"
        exit 1
    fi
else
    echo "Error: Unsupported OS"
    exit 1
fi

# Chrome flags for production
CHROME_BASE_FLAGS="--remote-debugging-port=$CDP_PORT --remote-debugging-address=127.0.0.1"

# Additional flags for containerized environments
if [ -f /.dockerenv ] || [ -n "$KUBERNETES_SERVICE_HOST" ]; then
    echo "Detected containerized environment, adding security flags"
    CHROME_FLAGS="$CHROME_BASE_FLAGS --no-sandbox --disable-dev-shm-usage --disable-gpu $CHROME_FLAGS"
else
    CHROME_FLAGS="$CHROME_BASE_FLAGS $CHROME_FLAGS"
fi

# Start Chrome with CDP
echo "Starting Chrome..."
"$CHROME_BIN" $CHROME_FLAGS \
    --user-data-dir="$METEOR_DIR/chrome-profile" \
    --log-file="$LOG_DIR/chrome.log" \
    --enable-logging \
    --v=0 \
    about:blank \
    >"$LOG_DIR/chrome.stdout.log" 2>"$LOG_DIR/chrome.stderr.log" &

CHROME_PID=$!
echo $CHROME_PID > "$PID_FILE"

# Wait for Chrome to start with timeout
echo "Waiting for Chrome to start..."
TIMEOUT=60
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
        echo "Chrome started successfully"
        break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "Error: Chrome failed to start within ${TIMEOUT}s"
    kill $CHROME_PID 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

# Write initial config before starting proxy
cat > "$CONFIG_FILE" <<EOF
{
  "proxyUrl": "http://127.0.0.1:$PROXY_PORT",
  "token": "$CDP_TOKEN",
  "cdpBackend": {
    "host": "127.0.0.1",
    "port": $CDP_PORT
  },
  "connectionUrl": "http://127.0.0.1:$PROXY_PORT?token=$CDP_TOKEN",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
}
EOF

# Start CDP proxy
echo "Starting CDP proxy..."
CDP_PORT=$CDP_PORT CDP_TOKEN=$CDP_TOKEN PROXY_PORT=$PROXY_PORT \
    node "$SCRIPT_DIR/meteor-cdp-proxy.js" \
    >"$LOG_DIR/proxy.stdout.log" 2>"$LOG_DIR/proxy.stderr.log" &
PROXY_PID=$!

# Update PID file with both PIDs
echo "$CHROME_PID $PROXY_PID" > "$PID_FILE"

# Wait for proxy to start
echo "Waiting for CDP proxy to start..."
TIMEOUT=30
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    if curl -s "http://127.0.0.1:$PROXY_PORT/health?token=$CDP_TOKEN" >/dev/null 2>&1; then
        echo "CDP proxy started successfully"
        break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "Error: CDP proxy failed to start within ${TIMEOUT}s"
    kill $CHROME_PID $PROXY_PID 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

echo ""
echo "✅ Meteor Browser is running in production mode!"
echo ""
echo "CDP Access:"
echo "  URL: http://127.0.0.1:$PROXY_PORT"
echo "  Token: $CDP_TOKEN"
echo ""
echo "Logs:"
echo "  Chrome: $LOG_DIR/chrome.*.log"
echo "  Proxy: $LOG_DIR/proxy.*.log"
echo ""
echo "Configuration: $CONFIG_FILE"
echo "PID file: $PID_FILE"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down Meteor Browser..."
    
    if [ -f "$PID_FILE" ]; then
        # Read both PIDs
        read CHROME_PID PROXY_PID < "$PID_FILE"
        
        # Kill proxy first
        if [ ! -z "$PROXY_PID" ] && ps -p $PROXY_PID > /dev/null 2>&1; then
            echo "Stopping CDP proxy (PID: $PROXY_PID)..."
            kill $PROXY_PID 2>/dev/null || true
        fi
        
        # Kill Chrome
        if [ ! -z "$CHROME_PID" ] && ps -p $CHROME_PID > /dev/null 2>&1; then
            echo "Stopping Chrome (PID: $CHROME_PID)..."
            kill $CHROME_PID 2>/dev/null || true
        fi
        
        rm -f "$PID_FILE"
    fi
    
    echo "Meteor Browser stopped"
}

# Set up cleanup on script exit
trap cleanup EXIT INT TERM

# For production, don't wait for Chrome - let the script exit
# The processes will continue running in the background
if [ -n "$METEOR_DAEMON" ]; then
    echo "Running in daemon mode - processes will continue in background"
    trap - EXIT  # Remove exit trap in daemon mode
else
    # Wait for Chrome to exit
    wait $CHROME_PID
fi