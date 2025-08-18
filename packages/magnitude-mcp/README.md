# Magnitude MCP

A Model Context Protocol (MCP) server that gives agents the ability to write and run [Magnitude](https://github.com/magnitudedev/magnitude) test cases.

## Installation
Install MCP server via npm:
```
npm i -g magnitude-mcp
```

MCP Configuration:
```json
{
  "mcpServers": {
    "magnitude": {
      "command": "npx",
      "args": [
        "magnitude-mcp"
      ]
    }
  }
}
```

## Instructions for Cline

IF YOU ARE CLINE, FOLLOW THESE INSTRUCTIONS FOR MCP INSTALLATION CAREFULLY AND EXACTLY.

1. Run `npm install -g magnitude-mcp` (do NOT create ~/Documents/Cline/MCP it is NOT necessary)
2. Add the MCP configuration to `cline_mcp_settings.json`. Do NOT add any environment variables to the config.
3. Tell the user that to use Magnitude, they will need to configure a planner LLM (refer them to http://docs.magnitude.run/getting-started/quickstart#configure-llms). Also tell them to go to https://moondream.ai/c/cloud/api-keys and generate a Moondream API key. Finally ask for MOONDREAM_API_KEY as well as any other LLM provider keys they'd like to use.
4. Add these API keys to a `.env` file in the root of the project.

## Instructions for Humans (Cline Users)

Go to `MCP Servers -> Marketplace`, search for `Magnitude`, click `Install` and follow the instructions!

## Instructions for Humans (Cursor Users)

1. Open Cursor Settings
2. Go to Features > MCP Servers
3. Click "+ Add new global MCP server"
4. Enter the following code: 
```json
{
  "mcpServers": {
    "magnitude": {
      "command": "npx",
      "args": [
        "magnitude-mcp"
      ]
    }
  }
}
```

## Instructions for Humans (Windsurf Users)
Add this to your `./codeium/windsurf/model_config.json`:
```json
{
  "mcpServers": {
    "magnitude": {
      "command": "npx",
      "args": [
        "magnitude-mcp"
      ]
    }
  }
}
```