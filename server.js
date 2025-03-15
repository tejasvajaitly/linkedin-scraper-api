// const express = require('express');
// const app = express();

// // Middleware to parse JSON request bodies.
// app.use(express.json());

// // Import Playwright for scraping
// const playwright = require('playwright');

// // Define a function that uses Playwright to scrape the page
// async function scrapePage(url, fields, cookies) {
//   console.log(`Scraping ${url}`);
//   const browser = await playwright.chromium.launch({ headless: false });
//   const context = await browser.newContext();

//   // If cookies are provided, add them to the context.
//   if (cookies && Array.isArray(cookies)) {
//     console.log('Adding cookies to the context');
//     await context.addCookies(cookies);
//   }
  
//   const page = await context.newPage();
  
//   // Navigate to the provided URL and wait until network is idle
//   await page.goto(url, { waitUntil: 'load', timeout: 120000 });
//   console.log("Page loaded");
  
//     const button = await page.$('button[aria-label^="Current company:"]');
//     if (button) {
//     const ariaLabel = await button.getAttribute('aria-label');
//     // "Current company: WisdomAI. Click to skip to experience card"
//     const match = ariaLabel.match(/Current company:\s*(.*?)\.\s*Click to skip/);
//     if (match) {
//         const currentCompany = match[1]; // e.g. "WisdomAI"
//         console.log("Current company:", currentCompany);
//     }
//     }

//   // You can expand this to scrape additional fields based on the 'fields' parameter
  
//   await browser.close();
//   return { htmlContent };
// }

// // Simple GET endpoint
// app.get('/', (req, res) => {
//   res.send('Hello, World!');
// });

// // POST endpoint for /scrape
// app.post('/scrape', async (req, res) => {
//   try {
//     const { url, fields, cookies } = req.body;
//     if (!url) {
//       return res.status(400).json({ error: 'URL is required' });
//     }
    
//     const data = await scrapePage(url, fields, cookies);
//     res.json(data);
//   } catch (error) {
//     console.error('Scrape error:', error);
//     res.status(500).json({ error: error.toString() });
//   }
// });

// const port = 3000;
// app.listen(port, () => {
//   console.log(`Server running on http://localhost:${port}`);
// });




const express = require('express');
const app = express();

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
  
  // Launch browser (set headless: false to see the browser UI)
  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext();

  // Add cookies if provided.
  if (cookies && Array.isArray(cookies)) {
    console.log('Adding cookies to context');
    await context.addCookies(cookies);
  }
  
  const page = await context.newPage();
  
  // Navigate to the search results page.
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  console.log("Search results page loaded");

  // Wait for profile cards to be present.
  await page.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 30000 });
  
  // Get all profile cards.
  const profileCards = await page.$$('div[data-view-name="search-entity-result-universal-template"]');
  console.log(`Found ${profileCards.length} profile cards`);

  const results = [];
  
  // Iterate over each profile card.
  for (let i = 0; i < profileCards.length; i++) {
    console.log(`Processing profile card ${i + 1} of ${profileCards.length}`);
    
    // Re-fetch the card to avoid stale element handles.
    const card = (await page.$$('div[data-view-name="search-entity-result-universal-template"]'))[i];
    if (!card) continue;
    
    // Extract the profile link from the card using an anchor with href starting with "https://www.linkedin.com/in/"
    let profileLink = null;
    try {
      profileLink = await card.$eval('a[href^="https://www.linkedin.com/in/"]', a => a.href);
    } catch (e) {
      console.error(`Could not extract link for profile card ${i+1}:`, e);
      results.push({ profile: null, error: "Could not extract link" });
      continue;
    }
    
    // Open a new page and navigate to the profile link.
    const profilePage = await context.newPage();
    try {
      await profilePage.goto(profileLink, { waitUntil: 'load', timeout: 60000 });
      console.log(`Profile page loaded: ${profilePage.url()}`);
      
      // Wait for the button with an ARIA label starting with "Current company:".
      await profilePage.waitForSelector('button[aria-label^="Current company:"]', { timeout: 10000 });
      const button = await profilePage.$('button[aria-label^="Current company:"]');
      let currentCompany = null;
      
      if (button) {
        const ariaLabel = await button.getAttribute('aria-label');
        // Example ARIA label: "Current company: WisdomAI. Click to skip to experience card"
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

const port = 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});