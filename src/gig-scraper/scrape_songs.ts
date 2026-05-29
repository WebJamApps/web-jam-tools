/// <reference lib="dom" />
// Scrape song rows (id + text) from joshandmariamusic.com/music/songs.
// Run: deno task scrape:songs
import { chromium } from "playwright";

const HERE = import.meta.dirname!;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log("--- Scraping Song IDs from joshandmariamusic.com ---");
await page.goto("https://www.joshandmariamusic.com/music/songs", { waitUntil: "networkidle" });
await page.waitForTimeout(5000);

await Deno.writeTextFile(`${HERE}/page_debug.html`, await page.content());

const results = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll(".MuiDataGrid-row"));
  return rows.map((row) => {
    const id = row.getAttribute("data-id");
    const cells = Array.from(row.querySelectorAll(".MuiDataGrid-cell"));
    const text = cells.map((c) => (c as HTMLElement).innerText.trim()).join(" | ");
    return { id, text };
  });
});

console.log("Found Rows:", JSON.stringify(results, null, 2));

await browser.close();
