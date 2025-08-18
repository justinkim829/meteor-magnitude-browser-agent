# Testing Magnitude Sidebar Integration

## Prerequisites

1. **Chrome with CDP enabled** (already running on port 9222):
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/chrome-cdp-profile \
     --no-first-run \
     --no-default-browser-check
   ```

2. **Enhanced MCP Server** (already running on port 9123):
   ```bash
   cd /Users/justinkim829/Documents/meteor/chromium/src/chrome/browser/chat/tools/magnitude
   node magnitude_mcp_server.js
   ```

3. **Chromium Build** with Magnitude integration:
   ```bash
   cd /Users/justinkim829/Documents/meteor/chromium/src
   out/Default/Chromium.app/Contents/MacOS/Chromium --enable-logging
   ```

## Test Procedure

1. **Open Chromium** (the custom build, not regular Chrome)
2. **Click the send icon** next to the URL bar (tooltip: "Ask Meteor, your personal browser agent")
3. **Open a new tab** in the browser
4. **Type in the chat sidebar**: 
   ```
   Use magnitude agent. Find the cheapest flight from SEA to SFO scheduled tomorrow.
   ```

## Expected Behavior

1. **Chat assistant recognizes the magnitude_agent tool** call
2. **Magnitude MCP server receives the request** on port 9123
3. **Browser automation starts in the current tab**:
   - Navigates to a flight search website (e.g., Expedia)
   - Fills in SEA as departure
   - Fills in SFO as destination
   - Sets tomorrow's date
   - Searches for flights
   - Finds and reports the cheapest option
4. **Real-time narrator events** appear in the sidebar showing progress
5. **Final result** is displayed in the chat

## Debugging

Check the following logs:
- **Chromium console**: Look for ChatService and MagnitudeTool logs
- **MCP Server output**: Should show incoming requests and browser actions
- **Browser DevTools console**: Any JavaScript errors

## Alternative Test Commands

Try these simpler commands first if the flight search is too complex:

1. **Simple navigation**:
   ```
   Use magnitude agent to navigate to github.com
   ```

2. **Page extraction**:
   ```
   Use magnitude agent to extract the main headlines from news.ycombinator.com
   ```

3. **Form interaction**:
   ```
   Use magnitude agent to search for "artificial intelligence" on wikipedia
   ```

## Success Criteria

- ✅ Tool is recognized and executed
- ✅ MCP server receives and processes the request
- ✅ Browser automation occurs in the visible tab
- ✅ Results are returned to the chat sidebar
- ✅ No crashes or errors