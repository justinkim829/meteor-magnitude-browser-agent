# Magnitude Same-Browser New Tab Setup

## Overview

This guide explains how to use the Magnitude browser agent within the same Chromium instance, where each automation task opens in a new tab.

## How It Works

1. **Single Browser Instance**: You only need one Chromium window
2. **CDP Integration**: Chromium runs with Chrome DevTools Protocol enabled
3. **New Tab Per Task**: Each automation request opens a fresh tab
4. **Sidebar Control**: You control everything from the chat sidebar

## Setup Instructions

### 1. Launch Chromium with CDP Enabled

```bash
cd /Users/justinkim829/Documents/meteor/chromium/src/chrome/browser/chat/tools/magnitude
./launch_chromium_with_cdp.sh
```

Or manually:
```bash
cd /Users/justinkim829/Documents/meteor/chromium/src
out/Default/Chromium.app/Contents/MacOS/Chromium \
  --enable-logging \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check
```

### 2. Verify MCP Server is Running

The server should already be running. Check with:
```bash
curl http://localhost:9123/mcp/health
```

Expected response:
```json
{
  "status": "ok",
  "activeTasks": 0,
  "cdpUrl": "http://localhost:9222"
}
```

### 3. Use the Sidebar Chat

1. Click the **send icon** next to the URL bar
2. Type your automation command, for example:
   ```
   Use magnitude agent to find the cheapest flight from SEA to SFO tomorrow
   ```

### 4. Watch the Automation

- A **new tab** will open automatically
- The agent will navigate and perform the requested task
- You can continue using other tabs while it works
- Results will appear in the sidebar chat

## Example Commands

**Flight Search**:
```
Use magnitude agent to find flights from New York to London next week
```

**Shopping**:
```
Use magnitude agent to search for "wireless headphones" on Amazon and find the best rated ones under $100
```

**Research**:
```
Use magnitude agent to go to Wikipedia and extract information about artificial intelligence
```

**Navigation**:
```
Use magnitude agent to navigate to github.com and search for "magnitude browser automation"
```

## Architecture

```
Your Chromium Instance (CDP Port 9222)
├── Main Window
│   ├── Tab 1: Your browsing
│   ├── Tab 2: Sidebar Chat (control center)
│   └── Tab N: ...
│
└── Automation Tabs (created by Magnitude)
    ├── Task 1 Tab: Flight search
    ├── Task 2 Tab: Shopping
    └── Task N Tab: ...
```

## Technical Details

- **CDP Connection**: Magnitude connects to `localhost:9222`
- **New Context**: Each task creates a new browser context (tab)
- **Isolation**: Tasks run in separate tabs, don't interfere
- **Persistence**: Tabs stay open until manually closed

## Troubleshooting

### "Network request failed" Error
- Ensure Chromium is running with `--remote-debugging-port=9222`
- Check MCP server is healthy: `curl http://localhost:9123/mcp/health`
- Restart the MCP server if needed

### No New Tab Opens
- Verify CDP is enabled: `curl http://localhost:9222/json/version`
- Check browser console for errors
- Ensure no other Chrome instances are using port 9222

### Task Fails
- Check the MCP server logs: `tail -f magnitude_server_new_tab.log`
- Verify Anthropic API key is set in `.env`
- Try a simpler task first

## Benefits

1. **Single Browser**: No need for multiple browser instances
2. **Visual Feedback**: See automation happening in real-time
3. **Parallel Tasks**: Run multiple automations in different tabs
4. **Easy Debugging**: Inspect any automation tab directly
5. **Natural Workflow**: Use your browser normally while agent works

## Security Note

CDP exposes powerful browser control APIs on localhost:9222. This is safe for local development but should not be exposed to external networks.