// Dump the first sheet of the Gig Booking Worksheet to JSON next to this script.
// Run: deno task read:xlsx
import * as XLSX from "xlsx";

const HERE = import.meta.dirname!;
const XLSX_PATH = "/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx";

const workbook = XLSX.readFile(XLSX_PATH);
const worksheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(worksheet);

await Deno.writeTextFile(`${HERE}/gig_booking_2025_data.json`, JSON.stringify(data, null, 2));
console.log("Extracted data from Gig Booking Worksheet 2025.xlsx");
