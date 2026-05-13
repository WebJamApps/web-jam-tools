const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  console.log('Navigating to https://www.joshandmariamusic.com...');
  await page.goto('https://www.joshandmariamusic.com', { waitUntil: 'networkidle' });

  console.log('Page loaded. Searching for Material UI DataGrid and paginating...');

  const allGigs = [];
  let hasNext = true;
  let pageNum = 1;

  while (hasNext) {
    console.log(`Processing page ${pageNum}...`);
    
    // Wait for the grid to be loaded
    await page.waitForSelector('.MuiDataGrid-root');

    // Extract gigs from current view
    const pageGigs = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.MuiDataGrid-row'));
        return rows.map(row => {
            const cells = Array.from(row.querySelectorAll('.MuiDataGrid-cell'));
            return cells.map(cell => cell.innerText.trim()).join(' | ');
        });
    });

    allGigs.push(...pageGigs);
    console.log(`Found ${pageGigs.length} gigs on this page.`);

    // Find "Go to next page" button
    const nextButton = await page.$('button[aria-label="Go to next page"]');
    
    if (nextButton) {
        const isDisabled = await nextButton.evaluate(node => node.disabled || node.classList.contains('Mui-disabled'));
        if (!isDisabled) {
            await nextButton.click();
            pageNum++;
            // Wait for the grid to update - we can wait for the row content to change or just a timeout
            // Better: wait for the pagination text to update
            const oldPaginationText = await page.evaluate(() => document.querySelector('.MuiTablePagination-displayedRows')?.innerText);
            await page.waitForTimeout(1000); 
            
            // Wait until the displayed rows text changes
            let retry = 0;
            while (retry < 10) {
                const newPaginationText = await page.evaluate(() => document.querySelector('.MuiTablePagination-displayedRows')?.innerText);
                if (newPaginationText !== oldPaginationText) break;
                await page.waitForTimeout(500);
                retry++;
            }
        } else {
            console.log('Next button is disabled. Reached the end.');
            hasNext = false;
        }
    } else {
      console.log('Next button not found.');
      hasNext = false;
    }
    
    if (pageNum > 40) hasNext = false; // Safety break
  }

  // Deduplicate
  const uniqueGigs = Array.from(new Set(allGigs));
  console.log(`Total unique gigs found: ${uniqueGigs.length}`);
  
  // Format for output
  const rawData = uniqueGigs.join('\n---\n');
  fs.writeFileSync('/home/joshua/WebJamApps/gig-scraper/Past Gigs Raw Data.txt', rawData);

  // Clean list
  const cleanList = uniqueGigs.map(g => {
      // Data format: Date | Time | Location | Venue | Tickets
      const parts = g.split(' | ');
      if (parts.length >= 4) {
          return `${parts[0]} - ${parts[3]} (${parts[2]})`;
      }
      return g;
  }).join('\n');
  fs.writeFileSync('/home/joshua/WebJamApps/gig-scraper/Past Gigs List.txt', cleanList);

  await browser.close();
})();
