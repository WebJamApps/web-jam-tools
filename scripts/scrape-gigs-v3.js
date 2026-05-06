const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GIGS_URL = 'https://www.joshandmariamusic.com';
const OUTPUT_DIR = '/home/joshua/gdrive/GEMINI';

async function scrapeGigs() {
    console.log('Starting MuiDataGrid scrape of', GIGS_URL);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(GIGS_URL, { waitUntil: 'networkidle' });
    
    await page.waitForTimeout(5000);

    let allGigs = [];
    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage) {
        console.log(`Scraping page ${pageNum}...`);
        
        const pageGigs = await page.evaluate(() => {
            const rows = [];
            const gridRows = document.querySelectorAll('.MuiDataGrid-row');
            gridRows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('.MuiDataGrid-cell'))
                                   .map(c => c.innerText.trim());
                if (cells.length > 0) {
                    rows.push(cells.join(' | '));
                }
            });
            return rows;
        });

        allGigs = allGigs.concat(pageGigs);
        console.log(`Found ${pageGigs.length} gigs on this page.`);

        // Find Next Button
        hasNextPage = await page.evaluate(() => {
            const nextBtn = document.querySelector('button[aria-label="Go to next page"], button:has(svg[data-testid="KeyboardArrowRightIcon"])');
            if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('Mui-disabled')) {
                nextBtn.click();
                return true;
            }
            return false;
        });

        if (hasNextPage) {
            await page.waitForTimeout(1500); // Wait for grid to update
            pageNum++;
            if (pageNum > 50) break; // Safety
        }
    }

    await browser.close();
    return [...new Set(allGigs)];
}

async function main() {
    try {
        const scrapedGigs = await scrapeGigs();
        console.log(`Total unique gigs extracted: ${scrapedGigs.length}`);
        
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs Raw Data.txt'), scrapedGigs.join('\n'));
        
        // Final cleaning: Ensure we have at least 3 parts (Date, Time, Venue/Location)
        const cleanedGigs = scrapedGigs.filter(g => g.split('|').length >= 3);
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs List.txt'), cleanedGigs.join('\n'));
        
        console.log('Task 1 Complete. Files saved to Drive.');

    } catch (error) {
        console.error('Scrape failed:', error);
    }
}

main();
