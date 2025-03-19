const express = require('express');
const cors = require('cors');
const app = express();
const playwright = require('playwright');
require('dotenv').config();

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://mole.tejasvajaitly.com'
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
  })
);

app.use(express.json());

/**
 * scrapeProfiles sends events for each grouped phase.
 */
async function scrapeProfiles(url, fields, cookies, sendEvent) {
  // Group 1: Browser Setup
  sendEvent('browser-setup', { message: 'Launching browser' });
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  sendEvent('browser-setup', { message: 'Browser launched' });

  sendEvent('browser-setup', { message: 'Creating browser context' });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  });
  sendEvent('browser-setup', { message: 'Browser context created' });

  sendEvent('browser-setup', { message: 'Adding cookies' });
  if (cookies && Array.isArray(cookies)) {
    await context.addCookies(cookies);
  }
  sendEvent('browser-setup', { message: 'Cookies added' });

  sendEvent('browser-setup', { message: 'Opening new page' });
  const page = await context.newPage();
  sendEvent('browser-setup', { message: 'New page opened' });

  let allResults = [];
  let currentPage = 1;
  const maxPages = 2;
  let currentUrl = url;
  let finalHtml = []

  // Group 2: Loading LinkedIn Page
  while (currentPage <= maxPages) {
    sendEvent('playwright-scraping', { message: `Loading LinkedIn page` });
    await page.goto(currentUrl, { waitUntil: 'load', timeout: 120000 });
    sendEvent('playwright-scraping', { message: 'LinkedIn page loaded' });
    
    sendEvent('playwright-scraping', { message: 'Waiting for search result cards' });
    await page.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 30000 });
    sendEvent('playwright-scraping', { message: 'Search result cards found' });

    // Group 3: Extracting Profile Cards
    sendEvent('playwright-scraping', { message: `Extracting profile cards on ${currentPage}` });
     const cardsHtml = await page.$$eval(
      'div[data-view-name="search-entity-result-universal-template"]',
      (cards) => cards.map((card) => card.outerHTML)
    );
    sendEvent('playwright-scraping', { message: `Extracted profile cards on page ${currentPage}` });
    finalHtml.push(...cardsHtml)


    // Group 5: Navigating & Loading More Results
    if (currentPage < maxPages) {
      sendEvent('playwright-scraping', { message: 'Attempting to navigate to next page' });
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(5000);
        const nextButtons = await page.$$('button[aria-label="Next"]');
        if (nextButtons.length > 0) {
          await nextButtons[nextButtons.length - 1].click();
          sendEvent('playwright-scraping', { message: 'Clicked next button. Waiting for navigation' });
          await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
          currentUrl = page.url();
          sendEvent('playwright-scraping', { message: 'Browser navigated to next page' });
          currentPage++;
        } else {
          sendEvent('playwright-scraping', { message: 'No next button found. Ending pagination.' });
          break;
        }
      } catch (error) {
        sendEvent('error', { message: 'Error navigating to next page', error: error.toString() });
        break;
      }
    } else {
      sendEvent('playwright-scraping', { message: 'Pagination limit reached.' });
      break;
    }
  }


  try {
    sendEvent('openai-extracting', { message: 'Starting parallel processing of pages' });
    
    // Create array of promises with their index
    const pagePromises = finalHtml.map((pageCards, index) => {
      return testOpenAIBatch(pageCards)
        .then(result => {
          sendEvent('openai-extracting', { message: `Successfully processed profile ${index + 1}` });
          return result;
        })
        .catch(error => {
          sendEvent('error', { message: `Failed to process profile ${index + 1}`, error: error.toString() });
          throw error; // Re-throw to be caught by Promise.all
        });
    });
  
    const pageResults = await Promise.all(pagePromises);
    allResults = pageResults.flat();
    sendEvent('openai-extracting', { message: 'All pages processed successfully.' });
  
  } catch (openaiError) {
    sendEvent('error', { message: 'OpenAI error processing pages', error: openaiError.toString() });
    allResults = finalHtml.flat().map((html) => ({
      error: 'OpenAI processing failed',
      rawHtml: html,
    }));
  }

  // Group 6: Finalizing
  sendEvent('finishing', { message: 'Closing browser' });
  await browser.close();
  sendEvent('finishing', { message: 'Browser closed' });
  sendEvent('finishing', { message: 'Scraping finished' });
  return { results: allResults };
}

async function testOpenAIBatch(profilesHtml) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant that extracts specific information from LinkedIn search result cards. Always respond with valid JSON array.',
        },
        {
          role: 'user',
          content: `Extract information from these LinkedIn profile cards (${profilesHtml.length} cards). For each card, create an object with these fields: name, headline, location, currentCompany, profilePhotoUrl, profileUrl. Return ONLY a JSON array of these objects. Do not include any other text or explanation. Profile Cards HTML: ${JSON.stringify(
            profilesHtml
          )}`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) {
    console.log("Openai error", data.error)
    throw new Error(`OpenAI API Error: ${data.error.message}`);
  }

  const content = data.choices[0].message.content.trim();
  try {
    return JSON.parse(content);
  } catch (parseError) {
    const cleanedContent = content.replace(/^```json\n?|\n?```$/g, '');
    return JSON.parse(cleanedContent);
  }
}

/**
 * Helper function to send SSE events.
 */
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// GET endpoint for a simple greeting.
app.get('/', (req, res) => {
  res.send('Hello, World!');
});

/**
 * GET endpoint for /scrape using query parameters and Server-Sent Events.
 */
app.get('/scrape', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendEvent = (event, data) => {
    sendSSE(res, event, data);
  };

  try {
    const url = req.query.url;
    if (!url) {
      sendEvent('error', { message: 'URL is required' });
      return res.end();
    }
    const fields = req.query.fields ? JSON.parse(req.query.fields) : [];
    const cookies = req.query.cookies ? JSON.parse(req.query.cookies) : [];

    sendEvent('browser-setup', { message: 'Scraping started' });
    const data = await scrapeProfiles(url, fields, cookies, sendEvent);
    sendEvent('finishing', "wrapup!");
    sendEvent('result', data);
  } catch (error) {
    console.error('Scrape error:', error);
    sendEvent('error', { message: error.toString() });
  }
  
  res.end();
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});