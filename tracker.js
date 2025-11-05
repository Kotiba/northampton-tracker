import 'dotenv/config';
import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const SELECTORS = {
  JOB_CARD: 'li.hj-job',
  JOB_LINK: 'a',
  JOB_GRADE: '.hj-grade',
  JOB_SPECIALITY: '.hj-primaryspeciality',
  JOB_SALARY: '.hj-salary',
  JOB_WORKING_PATTERN: '.hj-workingperioddesc'
};

const TIMEOUTS = {
  NAVIGATION: 20000,
  SELECTOR_WAIT: 8000,
  PAGE_LOAD: 1500,
  NOTIFICATION_RATE_LIMIT: 800
};

const CONFIG = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  jobsUrl: 'http://northamptongeneral.nhs.uk/Work-for-Us/Job-Board.aspx#!/job_list/s2/Medical_Dental?_ts=10884&feedid=101589&SelfServiceRequest=true&locale=en-gb&iVersionNumber=12&prs=g6ZPge%2CHTevSc8kRfA9ZLvmn-49pWtJhXrAcocwpueii&prigp=true&_srt=startdate&_sd=a',
  dataFile: path.join(process.cwd(), 'data', 'jobs.json'),
  screenshotDir: path.join(process.cwd(), 'screenshots', 'nhs'),
  maxRetries: 3,
  retryDelay: 5000,
  headless: process.env.CI === 'false',
  enableCompletionNotification: true
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function validateConfig() {
  const required = {
    'TELEGRAM_BOT_TOKEN': CONFIG.telegramBotToken,
    'TELEGRAM_CHAT_ID': CONFIG.telegramChatId
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\n💡 Please set them in your .env file or environment\n');
    process.exit(1);
  }

  console.log('✅ All environment variables validated');
}

async function ensureDirectories() {
  await Promise.all([
    fs.mkdir(CONFIG.screenshotDir, { recursive: true }),
    fs.mkdir(path.dirname(CONFIG.dataFile), { recursive: true })
  ]);
}

function escapeMarkdown(text = '') {
  if (typeof text !== 'string') {
    text = String(text);
  }
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MAIN TRACKER CLASS
// ============================================================================

class NHSJobTracker {
  constructor() {
    this.browser = null;
    this.page = null;
    this.context = null;
  }

  async init() {
    console.log('🚀 Initializing browser...');
    
    this.browser = await chromium.launch({
      headless: CONFIG.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-GB,en-US;q=0.9,en;q=0.8',
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });

    this.page = await this.context.newPage();
    
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] });
    });

    this.page.on('console', msg => {
      const type = msg.type().toUpperCase();
      const text = msg.text();
      
      if (['ERROR', 'WARNING', 'LOG'].includes(type)) {
        if (!text.includes('Download the React DevTools')) {
          console.log(`[Browser ${type}] ${text}`);
        }
      }
    });
    
    this.page.on('pageerror', error => {
      console.error(`[Browser Page Error] ${error.message}`);
    });
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('🔒 Browser closed');
    }
  }

  async takeScreenshot(filename) {
    if (!this.page || this.page.isClosed()) {
      console.warn(`Skipping screenshot ${filename}: Page is not available.`);
      return null;
    }
    try {
      const filepath = path.join(CONFIG.screenshotDir, `${Date.now()}_${filename}`);
      await this.page.screenshot({ path: filepath, fullPage: true });
      console.log(`📸 Screenshot saved: ${filepath}`);
      return filepath;
    } catch (error) {
      console.error(`❌ Failed to take screenshot ${filename}: ${error.message}`);
      return null;
    }
  }

  async navigateToJobs() {
    console.log('🌐 Navigating to NHS job listings...');
    
    try {
      await this.page.goto(CONFIG.jobsUrl, { 
        waitUntil: 'networkidle',
        timeout: TIMEOUTS.NAVIGATION 
      });

      console.log('⏳ Waiting for page to load...');
      await delay(TIMEOUTS.PAGE_LOAD);
      
      await this.takeScreenshot('after-navigation.png');
      
      console.log('✅ Successfully navigated to job listings');
      return true;

    } catch (error) {
      console.error('❌ Navigation failed:', error.message);
      console.log('Current URL:', this.page.url());
      await this.takeScreenshot('navigation-error.png');
      throw error;
    }
  }

  async scrapeJobs() {
    console.log('📊 Scraping NHS job listings...');
    
    try {
      // Wait for job listings to appear
      await this.page.waitForSelector(SELECTORS.JOB_CARD, { 
        state: 'visible', 
        timeout: TIMEOUTS.SELECTOR_WAIT 
      }).catch(() => null);

      const jobCardCount = await this.page.locator(SELECTORS.JOB_CARD).count();
      if (jobCardCount === 0) {
        console.log('⚠️ No job cards found on the page to scrape.');
        await this.takeScreenshot('no-jobs-to-scrape.png');
        return [];
      }
      
      console.log(`Found ${jobCardCount} potential job cards.`);
      await this.takeScreenshot('before-scraping.png');

      const jobs = await this.page.evaluate(({ selectors, baseUrl }) => {
        let jobCards = document.querySelectorAll(selectors.JOB_CARD);
        console.log('[Browser] Job card query count:', jobCards.length);

        if (jobCards.length === 0) {
          console.log('[Browser] No job cards found with primary selector');
          return [];
        }

        const results = [];
        
        jobCards.forEach((card, index) => {
          try {
            const linkEl = card.querySelector(selectors.JOB_LINK);
            const gradeEl = card.querySelector(selectors.JOB_GRADE);
            const specialityEl = card.querySelector(selectors.JOB_SPECIALITY);
            const salaryEl = card.querySelector(selectors.JOB_SALARY);
            const workingPatternEl = card.querySelector(selectors.JOB_WORKING_PATTERN);
            
            const grade = gradeEl?.textContent?.trim() || 'Unknown Grade';
            const speciality = specialityEl?.textContent?.trim() || 'Unknown Speciality';
            const salary = salaryEl?.textContent?.trim() || 'Not specified';
            const workingPattern = workingPatternEl?.textContent?.trim() || 'Not specified';
            const link = linkEl?.href || '';
            
            // Use grade + speciality as the title
            const title = `${grade} - ${speciality}`;

            // Generate unique ID based on title
            const id = `nhs-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 100)}`;

            if (title && id) {
              results.push({
                id,
                title,
                grade,
                speciality,
                salary,
                workingPattern,
                hospital: 'Northampton General Hospital NHS Trust',
                location: 'Northampton',
                source: 'NHS Jobs',
                postedDate: {
                  relative: 'Recently posted',
                  actual: new Date().toISOString(),
                  timestamp: Date.now()
                },
                link: link || baseUrl,
                scrapedAt: new Date().toISOString()
              });
            } else {
              console.log(`[Browser] Skipping card ${index}: Invalid data`);
            }
          } catch (err) {
            console.error(`[Browser] Error parsing card ${index}: ${err.message}`);
          }
        });

        return results;
      }, { selectors: SELECTORS, baseUrl: CONFIG.jobsUrl });

      console.log(`✅ Scraped ${jobs.length} valid jobs from ${jobCardCount} cards.`);

      if (jobs.length > 0) {
        console.log('\n📋 Sample scraped jobs (up to 3):');
        jobs.slice(0, 3).forEach((job, i) => {
          console.log(`--- Job ${i+1} ---`);
          console.log(`  Title: ${job.title}`);
          console.log(`  Grade: ${job.grade}`);
          console.log(`  Speciality: ${job.speciality}`);
          console.log(`  Salary: ${job.salary}`);
          console.log(`  Working Pattern: ${job.workingPattern}`);
          console.log(`  Link: ${job.link}`);
        });
        console.log('--- End Sample ---\n');
      }

      return jobs;

    } catch (error) {
      console.error(`❌ Scraping failed: ${error.message}`);
      await this.takeScreenshot('scrape-error.png');
      throw error;
    }
  }

  async loadPreviousJobs() {
    try {
      await fs.mkdir(path.dirname(CONFIG.dataFile), { recursive: true });
      const data = await fs.readFile(CONFIG.dataFile, 'utf-8');
      const jobs = JSON.parse(data);
      console.log(`📂 Loaded ${jobs.length} previous jobs from ${CONFIG.dataFile}`);
      
      if (!Array.isArray(jobs)) {
        console.warn(`⚠️ Previous jobs data is not an array. Starting fresh.`);
        return [];
      }
      return jobs;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📄 No previous jobs file found, starting fresh.');
      } else {
        console.error(`❌ Error loading previous jobs: ${error.message}. Starting fresh.`);
      }
      return [];
    }
  }

  async saveJobs(jobs) {
    if (!Array.isArray(jobs)) {
      console.error('❌ Attempted to save non-array data. Aborting save.');
      return;
    }
    try {
      await fs.mkdir(path.dirname(CONFIG.dataFile), { recursive: true });
      await fs.writeFile(CONFIG.dataFile, JSON.stringify(jobs, null, 2), 'utf-8');
      console.log(`💾 Saved ${jobs.length} jobs to ${CONFIG.dataFile}`);
    } catch (error) {
      console.error(`❌ Error saving jobs: ${error.message}`);
    }
  }

  async sendTelegramMessage(message) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`,
        {
          chat_id: CONFIG.telegramChatId,
          text: message,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: false
        }
      );
      return true;
    } catch (error) {
      console.error(`❌ Failed to send Telegram message:`, error.response?.data || error.message);
      return false;
    }
  }

  async notifyNewJob(job) {
    const message = `
🆕 *New NHS Job Posted\\!*

*${escapeMarkdown(job.title)}*

🎖️ Grade: ${escapeMarkdown(job.grade)}

🏥 ${escapeMarkdown(job.hospital)}

📍 ${escapeMarkdown(job.location)}

💰 Salary: ${escapeMarkdown(job.salary)}

⏰ Working Pattern: ${escapeMarkdown(job.workingPattern)}

🔗 [View Job](${escapeMarkdown(job.link)})
    `.trim();

    const sent = await this.sendTelegramMessage(message);
    if (sent) {
      console.log(`✅ Telegram notification sent for: ${job.title}`);
    }
  }

  async notifyError(error, attemptNumber) {
    const message = `
❌ *NHS Tracker Error*

Attempt: ${attemptNumber}/${CONFIG.maxRetries}
Error: \`${escapeMarkdown(error.message)}\`

Time: ${escapeMarkdown(new Date().toISOString())}
    `.trim();

    await this.sendTelegramMessage(message);
  }

  async notifyRunCompletion(scrapedCount, newCount) {
    const escapedScrapedCount = String(scrapedCount);
    const escapedNewCount = String(newCount);
    
    let statusMessage = '';
    if (newCount > 0) {
      statusMessage = `✅ Run completed\\! 🎉 Found *${escapedNewCount}* new NHS job\\(s\\) out of ${escapedScrapedCount} scraped\\.`;
    } else {
      statusMessage = `✅ Run completed\\. Scraped ${escapedScrapedCount} NHS jobs, but *no new* ones found\\. 🕵️`;
    }

    const timestamp = new Date().toLocaleString('en-GB', { 
      dateStyle: 'short', 
      timeStyle: 'short', 
      hour12: false 
    });
    const escapedTimestamp = timestamp.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');

    const message = `
*NHS Job Tracker Status*

${statusMessage}

_Checked at: ${escapedTimestamp}_
`.trim();

    const sent = await this.sendTelegramMessage(message);
    if (sent) {
      console.log(`✅ Run completion notification sent.`);
    }
  }

  async compareAndNotify(currentJobs, previousJobs) {
    if (!Array.isArray(currentJobs) || !Array.isArray(previousJobs)) {
      console.error('compareAndNotify: Invalid job arrays. Aborting.');
      return 0;
    }

    const previousJobMap = new Map(previousJobs.map(j => [j.id, j]));
    const newJobs = currentJobs.filter(j => j.id && !previousJobMap.has(j.id));

    console.log(`🔍 Comparison: ${currentJobs.length} current, ${previousJobs.length} previous.`);

    if (newJobs.length === 0) {
      console.log('✅ No new jobs found.');
      return 0;
    }

    console.log(`🎉 Found ${newJobs.length} new NHS job(s)!`);

    newJobs.sort((a, b) => b.postedDate.timestamp - a.postedDate.timestamp);

    for (const job of newJobs) {
      console.log(`📨 Notifying: ${job.title}`);
      await this.notifyNewJob(job);
      if (newJobs.indexOf(job) < newJobs.length - 1) {
        await delay(TIMEOUTS.NOTIFICATION_RATE_LIMIT);
      }
    }
    return newJobs.length;
  }

  async run() {
    console.log(`🏥 Starting NHS tracker at ${new Date().toISOString()}`);
    let currentJobs = [];
    let newJobsCount = 0;

    try {
      await this.init();
      await this.navigateToJobs();
      
      currentJobs = await this.scrapeJobs();
      const previousJobs = await this.loadPreviousJobs();
      newJobsCount = await this.compareAndNotify(currentJobs, previousJobs);

      if (currentJobs.length > 0) {
        await this.saveJobs(currentJobs);
      }

      if (CONFIG.enableCompletionNotification) {
        await this.notifyRunCompletion(currentJobs.length, newJobsCount);
      }

      console.log(`✅ Run finished at ${new Date().toISOString()}`);

    } catch (error) {
      console.error(`❌ Fatal error: ${error.message}`);
      await this.takeScreenshot('fatal-error.png');
      throw error;
    } finally {
      await this.close();
    }
  }

  async runWithRetry() {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        console.log(`\n🔄 Attempt ${attempt}/${CONFIG.maxRetries}`);
        await this.run();
        console.log('✅ Run completed successfully!');
        return;
      } catch (error) {
        console.error(`❌ Attempt ${attempt} failed:`, error.message);
        
        await this.notifyError(error, attempt);
        
        if (attempt === CONFIG.maxRetries) {
          console.error('❌ All retry attempts exhausted');
          throw error;
        }
        
        console.log(`⏳ Waiting ${CONFIG.retryDelay / 1000}s before retry...`);
        await delay(CONFIG.retryDelay);
      }
    }
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let tracker = null;

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (tracker) await tracker.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (tracker) await tracker.close();
  process.exit(0);
});

// ============================================================================
// MAIN EXECUTION
// ============================================================================

validateConfig();
await ensureDirectories();

tracker = new NHSJobTracker();
await tracker.runWithRetry();