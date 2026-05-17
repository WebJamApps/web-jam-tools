const { chromium } = require('playwright');
const fs = require('fs');

async function debugScrape() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://www.joshandmariamusic.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    const structure = await page.evaluate(() => {
        const info = [];
        info.push('Title: ' + document.title);
        
        const iframes = Array.from(document.querySelectorAll('iframe')).map(i => i.src);
        info.push('Iframes: ' + iframes.length);
        iframes.forEach(src => info.push(' - ' + src));

        const textChunks = [];
        document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div, p').forEach(el => {
            const text = el.innerText.trim();
            if (text.includes('Gig') || text.includes('Performance') || text.includes('202')) {
                textChunks.push(`${el.tagName}: ${text.substring(0, 100)}`);
            }
        });
        info.push('Interesting Text Chunks: ' + textChunks.slice(0, 20).join('\n'));

        return info.join('\n');
    });

    console.log(structure);
    await browser.close();
}

debugScrape();
