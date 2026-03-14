#!/usr/bin/env node

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs').promises
const path = require('path')

const SHOPPING_LIST_URL =
  'https://www.amazon.com/alexaquantum/sp/alexaShoppingList'

let config

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
  log('Extracting Alexa items')

  await page.waitForSelector('.item-body,.shopping-list-container', {
    timeout: 20000
  })

  const items = await page.evaluate(() => {
    const selectors = [
      '.item-body .item-title',
      '[data-item-name]',
      '.shopping-list-item .item-name'
    ]

    for (const s of selectors) {
      const els = document.querySelectorAll(s)

      if (els.length) {
        return [...els]
          .map(e => e.dataset.itemName || e.textContent.trim())
          .filter(Boolean)
      }
    }

    return []
  })

  log(`Found ${items.length} items`, '📝')

  return items
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
          syncedAt: new Date().toISOString()
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

async function performSync(page, state) {
  await page.goto(SHOPPING_LIST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })

  await ensureLoggedIn(page)

  const items = await extractItems(page)

  state = await syncToTodoist(items, state)

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
      '--window-size=1920,1080'
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

  const { browser, page } = await launchBrowser()

  let state = await loadState()

  state = await performSync(page, state)

  const interval = (config.options.checkIntervalMinutes || 5) * 60000

  log(`Running every ${interval / 60000} minutes`, '⏱️')

  setInterval(async () => {
    try {
      state = await performSync(page, state)
    } catch (err) {
      log(err.message, '❌')
    }
  }, interval)
}

main()