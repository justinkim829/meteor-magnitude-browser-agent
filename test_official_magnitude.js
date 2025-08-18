#!/usr/bin/env node

/**
 * Test script for the official Magnitude MCP server
 */

import axios from 'axios';

const MCP_URL = 'http://localhost:9123';

async function testHealth() {
  console.log('Testing health endpoint...');
  try {
    const response = await axios.get(`${MCP_URL}/health`);
    console.log('✅ Health check:', response.data);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
  }
}

async function testListTools() {
  console.log('\nTesting tools endpoint...');
  try {
    const response = await axios.get(`${MCP_URL}/mcp/tools`);
    console.log('✅ Available tools:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ List tools failed:', error.message);
  }
}

async function testNavigation() {
  console.log('\nTesting navigation...');
  try {
    const response = await axios.post(`${MCP_URL}/mcp/tool/call`, {
      name: 'magnitude_navigate',
      arguments: {
        url: 'https://example.com'
      }
    });
    console.log('✅ Navigation result:', response.data);
  } catch (error) {
    console.error('❌ Navigation failed:', error.message);
  }
}

async function testAct() {
  console.log('\nTesting high-level action...');
  try {
    const response = await axios.post(`${MCP_URL}/mcp/tool/call`, {
      name: 'magnitude_act',
      arguments: {
        task: 'Click on the "More information..." link'
      }
    });
    console.log('✅ Act result:', response.data);
  } catch (error) {
    console.error('❌ Act failed:', error.message);
  }
}

async function testExtract() {
  console.log('\nTesting data extraction...');
  try {
    const response = await axios.post(`${MCP_URL}/mcp/tool/call`, {
      name: 'magnitude_extract',
      arguments: {
        instructions: 'Extract the main heading and first paragraph',
        schema: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraph: { type: 'string' }
          }
        }
      }
    });
    console.log('✅ Extract result:', response.data);
  } catch (error) {
    console.error('❌ Extract failed:', error.message);
  }
}

async function runTests() {
  console.log('Starting Magnitude Official MCP Server tests...\n');
  
  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await testHealth();
  await testListTools();
  await testNavigation();
  
  // Wait for navigation to complete
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  await testAct();
  await testExtract();
  
  console.log('\nTests completed!');
}

runTests().catch(console.error);