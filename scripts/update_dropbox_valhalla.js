const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const filePath = '/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx';

if (fs.existsSync(filePath)) {
    const workbook = XLSX.readFile(filePath);
    let updated = false;

    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        const updatedData = data.map(row => {
            // Check common column names for venue names
            const venueKey = Object.keys(row).find(k => /name|venue/i.test(k));
            if (venueKey && String(row[venueKey]).toLowerCase().includes('valhalla')) {
                updated = true;
                // Update comments or append to name
                const commentKey = Object.keys(row).find(k => /comments/i.test(k)) || 'comments';
                row[commentKey] = (row[commentKey] ? row[commentKey] + ' | ' : '') + 'PERMANENTLY CLOSED 2025';
            }
            return row;
        });

        if (updated) {
            const newSheet = XLSX.utils.json_to_sheet(updatedData);
            workbook.Sheets[sheetName] = newSheet;
        }
    });

    if (updated) {
        XLSX.writeFile(workbook, filePath);
        console.log(`Successfully updated Dropbox spreadsheet: ${filePath}`);
    } else {
        console.log("Valhalla not found in spreadsheet.");
    }
} else {
    console.log(`Spreadsheet not found at: ${filePath}`);
}
