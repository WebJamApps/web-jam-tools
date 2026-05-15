const XLSX = require('xlsx');
const fs = require('fs');
const filePath = '/home/joshua/gdrive/CLAUDE/Gig Booking Worksheet 2025.xlsx';

if (fs.existsSync(filePath)) {
    const workbook = XLSX.readFile(filePath);
    let updated = false;
    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);
        const updatedData = data.map(row => {
            const venueKey = Object.keys(row).find(k => /name|venue/i.test(k));
            if (venueKey) {
                const venueName = String(row[venueKey]).toLowerCase();
                
                // Olde Salem update
                if (venueName.includes('olde salem')) {
                    updated = true;
                    const commentKey = Object.keys(row).find(k => /comments|notes/i.test(k)) || 'Notes';
                    row[commentKey] = "Matt Kimble (2026-05-11): Full through end of 2026.";
                    row['Status'] = 'X';
                }
                
                // Cavendish update
                if (venueName.includes('cavendish')) {
                    updated = true;
                    const commentKey = Object.keys(row).find(k => /comments|notes/i.test(k)) || 'Notes';
                    row[commentKey] = "Permanently closed Jan 2026. Replaced by Sugar Creek.";
                    row['Status'] = 'X';
                }
            }
            return row;
        });
        if (updated) workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(updatedData);
    });
    if (updated) {
        XLSX.writeFile(workbook, filePath);
        console.log("Successfully updated " + filePath);
    } else {
        console.log("No matching venues found in " + filePath);
    }
} else {
    console.error("File not found: " + filePath);
}
