const XLSX = require('xlsx');
const fs = require('fs');

const workbook = XLSX.readFile('/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

fs.writeFileSync('/home/joshua/WebJamApps/gig-scraper/gig_booking_2025_data.json', JSON.stringify(data, null, 2));
console.log('Extracted data from Gig Booking Worksheet 2025.xlsx');
