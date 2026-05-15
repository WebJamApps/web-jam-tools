const fs = require('fs');
const XLSX = require('xlsx');

const trackerPath = '/home/joshua/gdrive/CLAUDE/Venue Outreach Tracker';
const xlsxPath = '/home/joshua/gdrive/CLAUDE/Gig Booking Worksheet 2025.xlsx';
const dropboxXlsxPath = '/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx';

// 1. Update Tracker
let tracker = fs.readFileSync(trackerPath, 'utf8');

// Update Macado's Downtown entry
tracker = tracker.replace(/Macado's — Downtown Roanoke, VA\n    Contact: \(look up address\/phone\)\n    Method: TBD/g, 
    "Macado's — Downtown Roanoke, VA\n    Contact: (540) 342-7231 | Jimmy (GM)\n    Method: Call");

// Update Beast of Blacksburg entry
tracker = tracker.replace(/Beast of Blacksburg — Blacksburg, VA\n    Contact: \(look up phone\)\n    Method: Call/g,
    "Beast of Blacksburg — Blacksburg, VA\n    Contact: (540) 953-1975\n    Method: Call");

fs.writeFileSync(trackerPath, tracker);
console.log('Tracker updated.');

// 2. Update XLSX
const workbook = XLSX.readFile(xlsxPath);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

const updateXlsxVenue = (venueName, phone, contact, comments) => {
    let found = false;
    for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).includes(venueName)) {
            data[i][3] = phone; // phone #
            data[i][1] = contact; // Contact
            data[i][6] = comments; // comments
            found = true;
            break;
        }
    }
    if (!found) {
        data.push([venueName, contact, '', phone, 'Pub', '', comments, '', '[ ]', '', '', '', venueName]);
    }
};

updateXlsxVenue("Macado's Downtown", "(540) 342-7231", "Jimmy (GM)", "Referred from South County visit. Call to ask about live music.");
updateXlsxVenue("Beast of Blacksburg", "(540) 953-1975", "", "Confirm if still booking live music. Reported active May 2026.");

workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(data);
XLSX.writeFile(xlsxPath);
console.log('XLSX updated.');

// 3. Sync to Dropbox
fs.copyFileSync(xlsxPath, dropboxXlsxPath);
console.log('Dropbox sync complete.');
