import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer-core';

const BROWSERLESS_URL = process.env.BROWSERLESS_API_KEY
  ? `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`
  : null;

/**
 * AI-powered unsubscribe agent.
 * 1. Opens the unsubscribe URL in a headless browser
 * 2. Takes a screenshot
 * 3. Sends it to Claude to understand the page
 * 4. Executes Claude's instructions (fill forms, click buttons)
 * 5. Verifies success
 */
export async function aiUnsubscribe(
  unsubscribeUrl: string,
  userEmail: string
): Promise<{ success: boolean; method: string; details: string }> {
  if (!BROWSERLESS_URL) {
    return { success: false, method: 'ai_agent', details: 'BROWSERLESS_API_KEY not configured' };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return { success: false, method: 'ai_agent', details: 'ANTHROPIC_API_KEY not configured' };
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  let browser;

  try {
    // Connect to headless browser
    browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS_URL });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to unsubscribe URL
    await page.goto(unsubscribeUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000)); // Wait for JS to render

    // Take screenshot
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    // Get page text content for context
    const pageText = await page.evaluate(() => {
      return document.body?.innerText?.slice(0, 3000) || '';
    });

    // Check if already unsubscribed (page loaded = one-click success)
    const alreadyDone = /unsubscrib(ed|e success|tion complete|tion confirmed|successfully|you.*(removed|opted out))/i.test(pageText);
    if (alreadyDone) {
      await browser.close();
      return { success: true, method: 'ai_agent_oneclick', details: 'Page confirmed unsubscription on load' };
    }

    // Ask Claude to analyze the page and tell us what to do
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot as string },
          },
          {
            type: 'text',
            text: `You are an AI agent helping a user unsubscribe from an email list. The user's email is: ${userEmail}

This is a screenshot of an unsubscribe page. Analyze it and respond with a JSON array of actions to complete the unsubscription.

Available actions:
- {"type": "click", "selector": "CSS selector of element to click"}
- {"type": "fill", "selector": "CSS selector of input", "value": "text to type"}
- {"type": "select", "selector": "CSS selector of dropdown", "value": "option value"}
- {"type": "done", "message": "Already unsubscribed or confirmation visible"}
- {"type": "captcha", "message": "Page has a captcha that cannot be automated"}
- {"type": "unknown", "message": "Cannot determine how to unsubscribe"}

Rules:
- If there's a simple "Unsubscribe" or "Confirm" button, just click it
- If there's an email field, fill it with the user's email then click submit
- If there's a reason dropdown, select any reason
- If the page already shows a success/confirmation message, return done
- If there's a captcha, return captcha
- Use specific CSS selectors that would work with document.querySelector()

Respond ONLY with the JSON array, no explanation. Example:
[{"type": "fill", "selector": "input[type=email]", "value": "${userEmail}"}, {"type": "click", "selector": "button[type=submit]"}]

Page text content: ${pageText.slice(0, 1000)}`
          }
        ],
      }],
    });

    // Parse Claude's response
    const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
    let actions: { type: string; selector?: string; value?: string; message?: string }[];

    try {
      // Extract JSON from response (Claude might wrap it in markdown)
      const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
      actions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      await browser.close();
      return { success: false, method: 'ai_agent', details: `Could not parse AI response: ${responseText.slice(0, 200)}` };
    }

    // Execute actions
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'done':
            await browser.close();
            return { success: true, method: 'ai_agent_confirmed', details: action.message || 'Already unsubscribed' };

          case 'captcha':
            await browser.close();
            return { success: false, method: 'ai_agent_captcha', details: action.message || 'Captcha detected' };

          case 'unknown':
            await browser.close();
            return { success: false, method: 'ai_agent_unknown', details: action.message || 'Could not determine unsubscribe method' };

          case 'fill':
            if (action.selector && action.value) {
              await page.waitForSelector(action.selector, { timeout: 5000 });
              await page.type(action.selector, action.value, { delay: 50 });
            }
            break;

          case 'select':
            if (action.selector && action.value) {
              await page.waitForSelector(action.selector, { timeout: 5000 });
              await page.select(action.selector, action.value);
            }
            break;

          case 'click':
            if (action.selector) {
              await page.waitForSelector(action.selector, { timeout: 5000 });
              await page.click(action.selector);
              await new Promise(r => setTimeout(r, 3000)); // Wait for navigation/response
            }
            break;
        }
      } catch (actionErr) {
        // Try to continue with remaining actions even if one fails
        console.error(`Action failed: ${JSON.stringify(action)}`, actionErr);
      }
    }

    // Wait for page to settle after actions
    await new Promise(r => setTimeout(r, 2000));

    // Verify: take another screenshot and check for success
    const finalText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    const succeeded = /unsubscrib(ed|e success|tion complete|tion confirmed|successfully|you.*(removed|opted out)|preference.*(saved|updated))/i.test(finalText);

    await browser.close();

    if (succeeded) {
      return { success: true, method: 'ai_agent_form', details: `Completed ${actions.length} actions, confirmed success` };
    }

    // Not sure if it worked — might have still processed
    return { success: true, method: 'ai_agent_attempted', details: `Completed ${actions.length} actions, could not verify success` };

  } catch (err) {
    if (browser) try { await browser.close(); } catch {}
    return { success: false, method: 'ai_agent', details: String(err) };
  }
}
