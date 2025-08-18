const { startBrowserAgent } = require('./packages/magnitude-core/dist/index.js');

async function testCDPConnection() {
    try {
        console.log('Testing CDP connection with secure token...');
        
        // Test with the secure CDP URL including token
        const cdpUrl = 'http://localhost:9222?token=test-token-123';
        
        console.log(`Attempting to connect to CDP at: ${cdpUrl}`);
        
        const browserAgent = await startBrowserAgent({
            browser: { 
                cdp: cdpUrl,
                contextOptions: {
                    viewport: { width: 1280, height: 720 }
                }
            },
            llm: {
                provider: 'anthropic',
                options: {
                    model: 'claude-3-haiku-20240307',
                    temperature: 0.2
                }
            }
        });
        
        console.log('✅ SUCCESS: Browser agent created successfully!');
        
        // Test a simple page navigation
        await browserAgent.goto('https://example.com');
        console.log('✅ SUCCESS: Page navigation completed!');
        
        await browserAgent.stop();
        console.log('✅ SUCCESS: Browser agent stopped cleanly!');
        
    } catch (error) {
        console.error('❌ ERROR:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

testCDPConnection(); 