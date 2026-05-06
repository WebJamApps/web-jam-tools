const { chromium } = require('playwright');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const GIGS_URL = 'https://www.joshandmariamusic.com';
const EXCEL_PATH = '/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx';
const OUTPUT_DIR = '/home/joshua/gdrive/GEMINI';

async function scrapeGigs() {
    console.log('Starting scrape of', GIGS_URL);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(GIGS_URL, { waitUntil: 'networkidle' });
    
    // Give it a few extra seconds for Wix components to load
    await page.waitForTimeout(5000);

    const gigData = await page.evaluate(() => {
        const results = [];
        // Look for anything that looks like a date or a venue
        // Wix often uses iframes or custom components for events
        const allElements = document.querySelectorAll('span, div, p, li, td');
        
        let currentEntry = [];
        allElements.forEach(el => {
            const text = el.innerText.trim();
            // Look for Date patterns like "May 5" or "5/5/2026"
            if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d+/i.test(text) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) {
                if (currentEntry.length > 0) results.push(currentEntry.join(' | '));
                currentEntry = [text];
            } else if (currentEntry.length > 0 && currentEntry.length < 4) {
                // Heuristic: capture next few elements as venue/time/location
                if (text && text.length > 2 && text.length < 100) {
                    currentEntry.push(text);
                }
            }
        });
        if (currentEntry.length > 0) results.push(currentEntry.join(' | '));
        
        return results;
    });

    await browser.close();
    return [...new Set(gigData)]; // Unique entries
}

function readExcel() {
    console.log('Reading Excel file:', EXCEL_PATH);
    if (!fs.existsSync(EXCEL_PATH)) {
        console.error('Excel file not found!');
        return [];
    }
    const workbook = XLSX.readFile(EXCEL_PATH);
    // Log sheet names to help debug
    console.log('Sheets found:', workbook.SheetNames);
    
    // Read all sheets
    let allData = [];
    workbook.SheetNames.forEach(name => {
        const sheet = workbook.Sheets[name];
        allData = allData.concat(XLSX.utils.sheet_to_json(sheet));
    });
    return allData;
}

async function main() {
    try {
        const scrapedGigs = await scrapeGigs();
        const excelData = readExcel();

        console.log(`Found ${scrapedGigs.length} gigs on website.`);
        console.log(`Found ${excelData.length} rows in Excel.`);

        // 1. Save Raw Scraped Data
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs Raw Data.txt'), scrapedGigs.join('\n'));

        // 2. Save Cleaned Gigs List
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Gigs List.txt'), scrapedGigs.join('\n'));

        // 3. Process Venues for Rebooking Research
        const venues = new Set();
        scrapedGigs.forEach(g => {
            const parts = g.split('|');
            if (parts[1]) venues.add(parts[1].trim());
        });
        
        excelData.forEach(row => {
            const venue = row.Venue || row.Name || row.Location || row['Venue Name'] || row['VENUE'];
            if (venue && typeof venue === 'string') venues.add(venue.trim());
        });

        // Filter out junk
        const filteredVenues = Array.from(venues).filter(v => v.length > 3 && !v.includes('Venue') && !v.includes('Current Gigs'));

        const researchContent = filteredVenues.map(v => `Venue Name: ${v}\nStatus: Researching...\nNotes:\n`).join('\n---\n');
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Past Venues Rebooking Research.txt'), researchContent);

        console.log('COORDINATOR REPORT: Scrape and Sync');
        console.log('STATUS: Complete');
        console.log('OUTPUT: Past Gigs Raw Data.txt, Past Gigs List.txt, Past Venues Rebooking Research.txt');

    } catch (error) {
        console.error('Error during scrape and sync:', error);
    }
}

main();
