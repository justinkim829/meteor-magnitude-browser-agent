#!/usr/bin/env node

// Test script to verify MCP server is working correctly

async function testMCPServer() {
  const baseUrl = 'http://localhost:9123';
  
  console.log('Testing MCP Server at', baseUrl);
  
  // Test 1: Health check
  try {
    const healthResponse = await fetch(`${baseUrl}/mcp/health`);
    const healthData = await healthResponse.json();
    console.log('✅ Health check:', healthData);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
  }
  
  // Test 2: List tools
  try {
    const toolsResponse = await fetch(`${baseUrl}/mcp/tools`);
    const toolsData = await toolsResponse.json();
    console.log('✅ Available tools:', toolsData.tools.map(t => t.name));
  } catch (error) {
    console.error('❌ Tools listing failed:', error.message);
  }
  
  // Test 3: Simple navigation task
  try {
    console.log('\n📋 Testing navigation to example.com...');
    const taskResponse = await fetch(`${baseUrl}/mcp/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Navigate to example.com',
        mode: 'act',
        url: 'https://example.com'
      })
    });
    
    const taskData = await taskResponse.json();
    console.log('✅ Task result:', taskData.success ? 'Success' : 'Failed');
    if (taskData.error) {
      console.error('Error:', taskData.error);
    }
  } catch (error) {
    console.error('❌ Task execution failed:', error.message);
  }
}

testMCPServer().catch(console.error);