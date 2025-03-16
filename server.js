const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS for all requests
app.use(cors());

// Middleware to parse JSON request bodies.
app.use(express.json());

// Import Playwright for scraping.
const playwright = require('playwright');

/**
 * Scrapes all profiles from a LinkedIn search results page.
 * For each profile card (div with data-view-name="search-entity-result-universal-template"),
 * the code extracts the profile link from an anchor inside the card (using an href that starts with "https://www.linkedin.com/in/"),
 * opens the profile in a new page, then extracts the current company name from the button with the ARIA label.
 *
 * @param {string} url - URL of the LinkedIn search results page.
 * @param {Array} fields - (Optional) Additional fields (not used in this example).
 * @param {Array} cookies - Array of cookie objects for authentication.
 * @returns {Object} - An object with an array of results.
 */
async function scrapeProfiles(url, fields, cookies) {
  console.log(`Scraping search results page: ${url}`);
  
  const browser = await playwright.chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  });

  if (cookies && Array.isArray(cookies)) {
    console.log('Adding cookies to context');
    await context.addCookies(cookies);
  }
  
  const results = [];
  let currentPage = 1;
  const maxPages = 2;
  let currentUrl = url;
  const page = await context.newPage();

  while (currentPage <= maxPages) {
    console.log(`Processing page ${currentPage}`);
    
    await page.goto(currentUrl, { waitUntil: 'load', timeout: 120000 });
    console.log("Page loaded");

    await page.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 30000 });
    const profileCards = await page.$$('div[data-view-name="search-entity-result-universal-template"]');
    console.log(`Found ${profileCards.length} profile cards`);

    for (let i = 0; i < profileCards.length; i++) {
      // TESTING: Only process the last profile
      if (i < profileCards.length - 1) continue;
      
      const card = (await page.$$('div[data-view-name="search-entity-result-universal-template"]'))[i];
      if (!card) continue;
      
      let profileLink = null;
      try {
        profileLink = await card.$eval('a[href^="https://www.linkedin.com/in/"]', a => a.href);
      } catch (e) {
        console.error(`Could not extract link for profile card ${i+1}:`, e);
        results.push({ profile: null, error: "Could not extract link" });
        continue;
      }
      
      const profilePage = await context.newPage();
      try {
        await profilePage.goto(profileLink, { waitUntil: 'load', timeout: 60000 });
        console.log(`Profile page loaded: ${profilePage.url()}`);
        
        await profilePage.waitForSelector('button[aria-label^="Current company:"]', { timeout: 10000 });
        const button = await profilePage.$('button[aria-label^="Current company:"]');
        let currentCompany = null;
        
        if (button) {
          const ariaLabel = await button.getAttribute('aria-label');
          const match = ariaLabel.match(/Current company:\s*(.*?)\.\s*Click to skip/);
          if (match) {
            currentCompany = match[1].trim();
          }
        }
        
        console.log(`Extracted company: ${currentCompany}`);
        results.push({ profile: profilePage.url(), currentCompany });
      } catch (err) {
        console.error(`Error processing profile card ${i + 1}:`, err);
        results.push({ profile: profileLink, error: err.toString() });
      }
      
      await profilePage.close();
    }

    if (currentPage <= maxPages) {
      try {
        console.log('Scrolling to bottom of page...');
        // Scroll to bottom
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        // Wait a bit for content to load after scroll
        await page.waitForTimeout(5000);

        console.log('Looking for Next buttons...');
        const nextButtons = await page.$$('button[aria-label="Next"]');
        console.log(`Found ${nextButtons.length} Next buttons`);

        // Log details about each button found
        for (let i = 0; i < nextButtons.length; i++) {
          const buttonText = await nextButtons[i].evaluate(el => el.textContent.trim());
          const buttonClass = await nextButtons[i].evaluate(el => el.getAttribute('class'));
          console.log(`Button ${i + 1}:`, { text: buttonText, class: buttonClass });
        }
        
        if (nextButtons.length > 0) {
          console.log('Attempting to click the last Next button found...');
          // Click the last Next button (usually the pagination one)
          await nextButtons[nextButtons.length - 1].click();
          
          console.log('Waiting for navigation...');
          await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
          currentUrl = page.url();
          console.log('Navigation successful, new URL:', currentUrl);
          currentPage++;
        } else {
          console.log('No Next buttons found on the page');
          break;
        }
      } catch (error) {
        console.error('Error during pagination:', error);
        break;
      }
    } else {
      break;
    }
  }
  
  await browser.close();
  return { results };
}

// Simple GET endpoint.
app.get('/', (req, res) => {
  res.send('Hello, World!');
});

// POST endpoint for /scrape.
app.post('/scrape', async (req, res) => {
  try {
    const { url, fields, cookies } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const data = await scrapeProfiles(url, fields, cookies);
    res.json(data);
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: error.toString() });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});