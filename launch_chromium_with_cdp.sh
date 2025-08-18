#!/bin/bash

# Launch Chromium with CDP enabled for same-browser automation
# This allows Magnitude to connect to the same browser instance and open new tabs

echo "Launching Chromium with CDP enabled for same-browser automation..."
echo "Magnitude will be able to open new tabs in this browser instance"

cd /Users/justinkim829/Documents/meteor/chromium/src

# Launch with CDP on port 9222
# IMPORTANT: This is the ONLY Chromium instance you need
out/Default/Chromium.app/Contents/MacOS/Chromium \
  --enable-logging \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  2>&1 | tee chromium_with_cdp.log &

echo ""
echo "Chromium launched with CDP on port 9222"
echo "You can now:"
echo "1. Use the sidebar chat in this browser"
echo "2. When you ask Magnitude to do something, it will open a new tab"
echo ""
echo "Waiting for browser to start..."
sleep 3

# Verify CDP is working
echo "Checking CDP endpoint..."
curl -s http://localhost:9222/json/version | jq . || echo "CDP not ready yet"