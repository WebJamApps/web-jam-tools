const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('--- Step 3: Scraping Song IDs from joshandmariamusic.com ---');
  await page.goto('https://www.joshandmariamusic.com/music/songs', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  const html = await page.content();
  fs.writeFileSync('page_debug.html', html);
  
  const results = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.MuiDataGrid-row'));
    const data = rows.map(row => {
      const id = row.getAttribute('data-id');
      const cells = Array.from(row.querySelectorAll('.MuiDataGrid-cell'));
      const text = cells.map(c => c.innerText.trim()).join(' | ');
      return { id, text };
    });
    return data;
  });

  console.log('Found Rows:', JSON.stringify(results, null, 2));

  await browser.close();
})();
