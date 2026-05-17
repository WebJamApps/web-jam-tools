const fs = require('fs');
const path = require('path');

const inputPath = '/home/joshua/gdrive/GEMINI/Past Gigs List.txt';
const outputPath = '/home/joshua/gdrive/GEMINI/Unique Venues.txt';

const content = fs.readFileSync(inputPath, 'utf8');
const lines = content.split('\n');

const venues = new Set();
lines.forEach(line => {
    const parts = line.split('|');
    if (parts.length >= 4) {
        let venue = parts[3].trim();
        // Clean up common variations
        venue = venue.replace(/Stave (and|&) Cork.*/i, 'Stave & Cork');
        venue = venue.replace(/Beliveau (Farm )?Winery/i, 'Beliveau Farm Winery');
        venue = venue.replace(/Gusto's Pizza.*/i, "Gusto's Pizza");
        venue = venue.replace(/Olde Salem Brewing.*/i, 'Olde Salem Brewing Company');
        venue = venue.replace(/Salem Red Sox.*/i, 'Salem Red Sox');
        venue = venue.replace(/National Anthem.*/i, 'National Anthem');
        venue = venue.replace(/Private house party/i, 'Private');
        venue = venue.replace(/Private Event/i, 'Private');
        venue = venue.replace(/Private party/i, 'Private');
        
        if (venue && venue.length > 3 && !venue.includes('Private') && !venue.includes('National Anthem') && !venue.includes('New Album Recording')) {
            venues.add(venue);
        }
    }
});

fs.writeFileSync(outputPath, Array.from(venues).sort().join('\n'));
console.log(`Found ${venues.size} unique venues.`);
