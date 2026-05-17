const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GIGS_URL = 'https://www.joshandmariamusic.com';
const OUTPUT_DIR = '/home/joshua/gdrive/GEMINI';

async function scrapeGigs() {
    console.log('Starting advanced scrape of', GIGS_URL);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(GIGS_URL, { waitUntil: 'networkidle' });
    
    // Give it time to load Wix components
    await page.waitForTimeout(5000);

    let allGigs = [];
    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage) {
        console.log(`Scraping page ${pageNum}...`);
        
        const pageGigs = await page.evaluate(() => {
            const rows = [];
            // Target Wix table rows or repeated structures
            // common patterns for Wix events/tables
            const tableRows = document.querySelectorAll('[data-testid="table-row"], tr');
            
            tableRows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('[data-testid="table-cell"], td, span, div'))
                                   .map(c => c.innerText.trim())
                                   .filter(t => t.length > 0);
                if (cells.length >= 3) {
                    rows.push(cells.join(' | '));
                }
            });

            // If no table rows, try to find repeated elements with dates
            if (rows.length === 0) {
                const elements = Array.from(document.querySelectorAll('div, section'))
                                      .filter(el => el.innerText.includes('202') || el.innerText.includes('201'));
                // This is fallback, might be messy
            }

            return rows;
        });

        allGigs = allGigs.concat(pageGigs);

        // Check for Next button and click it
        hasNextPage = await page.evaluate(() => {
            const nextButtons = Array.from(document.querySelectorAll('button, a, span'))
                                     .filter(el => el.innerText.includes('Next') || el.innerText === '>');
            if (nextButtons.length > 0) {
                const btn = nextButtons[0];
                if (!btn.disabled && !btn.classList.contains('disabled')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (hasNextPage) {
            await page.waitForTimeout(2000); // Wait for page transition
            pageNum++;
            if (pageNum > 30) break; // Safety break
        }
    }

    await browser.close();
    return [...new Set(allGigs)];
}

async function main() {
    try {
        const scrapedGigs = await scrapeGigs();
        console.log(`Extracted ${scrapedGigs.length} unique gig entries.`);
        
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs Raw Data.txt'), scrapedGigs.join('\n'));
        
        // Clean up: try to format as Date | Venue | Location
        const cleanedGigs = scrapedGigs.filter(g => {
            // Filter out headers or junk
            return /\d{4}/.test(g) && g.split('|').length >= 3;
        });

        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs List.txt'), cleanedGigs.join('\n'));
        console.log('Saved data to Google Drive.');

    } catch (error) {
        console.error('Scrape failed:', error);
    }
}

main();
