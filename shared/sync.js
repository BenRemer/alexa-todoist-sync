#!/usr/bin/env node

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs').promises
const path = require('path')

const SHOPPING_LIST_URL =
  'https://www.amazon.com/alexaquantum/sp/alexaShoppingList'

let config
let browser = null
let intervalId = null

try {
  config = require('./config.json')
} catch {
  console.error('Missing config.json')
  process.exit(1)
}

const STATE_FILE = path.join(__dirname, config.options.stateFile)
const DRY_RUN = process.argv.includes('--dry-run')

function log(msg, emoji = 'ℹ️') {
  console.log(`[${new Date().toLocaleString()}] ${emoji} ${msg}`)
}

async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8')
    return JSON.parse(data)
  } catch {
    return { syncedItems: {}, lastSync: null }
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

async function ensureLoggedIn(page) {
  // wait for redirects to finish
  await page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: 15000
  }).catch(() => {})

  const url = page.url()

  if (url.includes('signin') || url.includes('/ap/')) {

    if (config.options.headless) {
      throw new Error(
        'Session not authenticated. Run once with headless:false and login manually.'
      )
    }

    log('Waiting for manual login...')

    await page.waitForFunction(
      () =>
        !location.href.includes('signin') &&
        !location.href.includes('/ap/'),
      { timeout: 0 }
    )

    log('Login detected')
  }
}

async function extractItems(page) {
  log('Extracting Alexa items from React virtual list...', '🕵️')

  // Wait for the new virtual list to render
  await page.waitForSelector('.virtual-list, .item-title', {
    timeout: 20000
  }).catch(() => log('Virtual list not found, trying anyway...', '⚠️'));

  const items = await page.evaluate(async () => {
    console.log('Starting virtual list extraction...');
    
    // Use a Set to automatically deduplicate items as we scroll
    const uniqueItems = new Set();
    
    // The main container that holds all the absolute positioned rows
    const listContainer = document.querySelector('.virtual-list');
    
    if (!listContainer) {
       console.log('❌ Could not find .virtual-list. Fallback to static extraction.');
       // Fallback for static lists
       const els = document.querySelectorAll('.item-title, [data-item-name]');
       els.forEach(el => {
          const name = el.dataset?.itemName || el.textContent.trim();
          if (name) uniqueItems.add(name);
       });
       return Array.from(uniqueItems);
    }

    // Function to extract currently visible items
    const scrapeVisible = () => {
        const els = document.querySelectorAll('.item-title');
        let foundNew = false;
        els.forEach(el => {
            const name = el.textContent.trim();
            if (name && !uniqueItems.has(name)) {
                uniqueItems.add(name);
                foundNew = true;
                console.log(`Extracted: "${name}" (Total: ${uniqueItems.size})`);
            }
        });
        return foundNew;
    };

    // Scroll through the virtual list
    await new Promise((resolve) => {
        let lastSize = 0;
        let noNewItemsCount = 0;
        const maxNoNew = 5; // Stop after 5 scrolls with no new items
        const distance = 400; // Pixels to scroll down each step
        
        const timer = setInterval(() => {
            scrapeVisible();
            
            // Scroll the specific virtual list container
            listContainer.scrollBy(0, distance);
            
            if (uniqueItems.size === lastSize) {
                noNewItemsCount++;
                console.log(`No new items found. Retry ${noNewItemsCount}/${maxNoNew}`);
                if (noNewItemsCount >= maxNoNew) {
                    clearInterval(timer);
                    resolve();
                }
            } else {
                lastSize = uniqueItems.size;
                noNewItemsCount = 0; // Reset if we found something
            }
        }, 300); // Check every 300ms
    });

    return Array.from(uniqueItems);
  });

  log(`Extracted ${items.length} items from virtual list.`, '📝')
  return items;
}

async function syncToTodoist(items, state) {
  const newItems = items.filter(item => !state.syncedItems[item])

  if (!newItems.length) {
    log('No new items')
    return state
  }

  log(`Syncing ${newItems.length} items`, '🔄')

  for (const item of newItems) {
    if (DRY_RUN) {
      log(`[DRY RUN] ${item}`)
      continue
    }

    try {
      const res = await fetch('https://api.todoist.com/api/v1/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.todoist.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: item,
          project_id: config.todoist.projectId
        })
      })

      if (res.ok) {
        const task = await res.json()

        state.syncedItems[item] = {
          todoistId: task.id,
          syncedAt: new Date().toISOString(),
          completedOnAlexa: false
        }

        log(`Synced: ${item}`, '✅')
      } else {
        log(`Todoist error ${res.status}`, '❌')
      }
    } catch (err) {
      log(`Sync error: ${err.message}`, '❌')
    }
  }

  state.lastSync = new Date().toISOString()

  return state
}

async function getCompletedTodoistTasks(state) {
  log('Checking Todoist for completed tasks', '🔍');

  const since = state.lastTodoistCheck || state.lastSync || new Date(0).toISOString();
  const until = new Date().toISOString();

  let data;
  try {
    const res = await fetch(
        `https://api.todoist.com/api/v1/tasks/completed/by_completion_date?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=200&project_id=${encodeURIComponent(config.todoist.projectId)}`,
        {
          headers: {
            Authorization: `Bearer ${config.todoist.apiToken}`,
            Accept: 'application/json',
          },
        }
    );

    if (!res.ok) {
      log(`Failed to get completed tasks: ${res.status}`, '❌');
      return [];
    }

    data = await res.json();
  } catch (err) {
    log(`Error fetching completed tasks: ${err.message}`, '❌');
    return [];
  }

  if (!Array.isArray(data.items)) {
    log('Unexpected API response structure', '❌');
    console.log(data);
    return [];
  }

  const completedContents = data.items
      .filter(t => t.checked)
      .map(t => t.content)
      .filter(Boolean);

  if (completedContents.length > 0) {
    log(`Found ${completedContents.length} completed task(s)`, '📋');
  } else {
    log('No completed tasks found', 'ℹ️');
  }

  return completedContents;
}

async function markItemsCompleteOnAlexa(page, items, state) {
  if (!items.length) return state;

  log(`Marking ${items.length} items complete on Alexa`, '🔄');

  for (const name of items) {
    const success = await page.evaluate(itemName => {
      // Find all shopping list items
      const elements = [...document.querySelectorAll('.item-title')];

      for (const el of elements) {
        const text = el.textContent.trim().toLowerCase();

        if (text === itemName.toLowerCase()) {
          // Find the closest custom checkbox label
          const row = el.closest('li, div.inner');
          const checkboxLabel = row?.querySelector('.custom-checkbox label');

          if (checkboxLabel) {
            checkboxLabel.click(); // Click the label, not the input
            return true;
          }
        }
      }
      return false;
    }, name);

    if (success) {
      state.syncedItems[name].completedOnAlexa = true;
      state.syncedItems[name].completedAt = new Date().toISOString();
      log(`Completed on Alexa: ${name}`, '✓');
    } else {
      log(`❌ Could not find clickable checkbox for: ${name}`);
    }
  }

  return state;
}

async function performSync(page, state) {
  await page.goto(SHOPPING_LIST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })

  await ensureLoggedIn(page)

  const items = await extractItems(page)

  state = await syncToTodoist(items, state)

  const completedInTodoist = await getCompletedTodoistTasks(state)
  state.lastTodoistCheck = new Date().toISOString()
  state = await markItemsCompleteOnAlexa(page, completedInTodoist, state)

  await saveState(state)

  log('Sync complete', '✅')

  return state
}

async function launchBrowser() {
  const userDataDir = path.join(__dirname, '.browser-profile')

  const browser = await puppeteer.launch({
    headless: config.options.headless ? 'new' : false,
    userDataDir,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  })

  const page = await browser.newPage()

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    })
  })

  await page.setViewport({ width: 1920, height: 1080 })

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )

  return { browser, page }
}

async function main() {
  log('Starting Alexa → Todoist sync', '🚀')

  const { browser: b, page } = await launchBrowser()
  browser = b

  let state = await loadState()

  state = await performSync(page, state)

  const interval = (config.options.checkIntervalMinutes || 5) * 60000

  log(`Running every ${interval / 60000} minutes`, '⏱️')

  intervalId = setInterval(async () => {
    try {
      state = await performSync(page, state)
    } catch (err) {
      console.error(err.message)
    }
  }, interval)
}

async function shutdown() {
  console.log(`[${new Date().toLocaleString()}] 👋 Shutting down gracefully...`)

  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }

  if (browser) {
    try {
      await browser.close()
    } catch (err) {
      console.error('Error closing browser:', err.message)
    }
    browser = null
  }

  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main()
