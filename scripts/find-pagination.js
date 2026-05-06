const { chromium } = require('playwright');

async function findPagination() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://www.joshandmariamusic.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    const paginationInfo = await page.evaluate(() => {
        const info = [];
        const elements = Array.from(document.querySelectorAll('*'));
        // Find small elements with the pattern
        const pagEl = elements.find(el => el.innerText && el.innerText.length < 50 && el.innerText.match(/\d+\s*–\s*\d+\s*of\s*\d+/));
        
        if (pagEl) {
            info.push('Pagination Text: ' + pagEl.innerText);
            info.push('Element Tag: ' + pagEl.tagName);
            info.push('Classes: ' + pagEl.className);
            
            // Find buttons in the parent
            let parent = pagEl.parentElement;
            info.push('Parent Tag: ' + (parent ? parent.tagName : 'NONE'));
            if (parent) {
                const clickables = Array.from(parent.querySelectorAll('button, [role="button"], svg, a'));
                info.push('Clickables in parent: ' + clickables.length);
                clickables.forEach((c, idx) => {
                    info.push(` Clickable ${idx}: ${c.tagName} ${c.className} ${c.getAttribute('data-testid') || ''}`);
                });
            }
        } else {
            info.push('Pagination text not found');
        }

        return info.join('\n');
    });

    console.log(paginationInfo);
    await browser.close();
}

findPagination();
