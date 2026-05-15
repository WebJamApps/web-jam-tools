const XLSX = require('xlsx');
const fs = require('fs');
const filePath = '/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx';

if (fs.existsSync(filePath)) {
    const workbook = XLSX.readFile(filePath);
    let updated = false;
    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);
        const updatedData = data.map(row => {
            const venueKey = Object.keys(row).find(k => /name|venue/i.test(k));
            if (venueKey && String(row[venueKey]).toLowerCase().includes('mac n bob')) {
                updated = true;
                const commentKey = Object.keys(row).find(k => /comments/i.test(k)) || 'comments';
                row[commentKey] = "Called 5/7/26: Left msg for Bobby Reynolds. Follow up 5/8.";
            }
            return row;
        });
        if (updated) workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(updatedData);
    });
    if (updated) XLSX.writeFile(workbook, filePath);
}
