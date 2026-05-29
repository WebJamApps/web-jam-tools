/// <reference lib="dom" />
// Scrape past gigs from joshandmariamusic.com (MUI DataGrid, paginated) and
// write a raw dump + a cleaned list next to this script.
// Run: deno task scrape:gigs
import { chromium } from "playwright";

const HERE = import.meta.dirname!;

const browser = await chromium.launch();
const page = await browser.newPage();
console.log("Navigating to https://www.joshandmariamusic.com...");
await page.goto("https://www.joshandmariamusic.com", { waitUntil: "networkidle" });

console.log("Page loaded. Searching for Material UI DataGrid and paginating...");

const allGigs: string[] = [];
let hasNext = true;
let pageNum = 1;

while (hasNext) {
  console.log(`Processing page ${pageNum}...`);
  await page.waitForSelector(".MuiDataGrid-root");

  const pageGigs = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".MuiDataGrid-row"));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll(".MuiDataGrid-cell"));
      return cells.map((cell) => (cell as HTMLElement).innerText.trim()).join(" | ");
    });
  });

  allGigs.push(...pageGigs);
  console.log(`Found ${pageGigs.length} gigs on this page.`);

  const nextButton = await page.$('button[aria-label="Go to next page"]');
  if (nextButton) {
    const isDisabled = await nextButton.evaluate((node) =>
      (node as HTMLButtonElement).disabled || node.classList.contains("Mui-disabled")
    );
    if (!isDisabled) {
      await nextButton.click();
      pageNum++;
      const oldPaginationText = await page.evaluate(() =>
        (document.querySelector(".MuiTablePagination-displayedRows") as HTMLElement)?.innerText
      );
      await page.waitForTimeout(1000);
      let retry = 0;
      while (retry < 10) {
        const newPaginationText = await page.evaluate(() =>
          (document.querySelector(".MuiTablePagination-displayedRows") as HTMLElement)?.innerText
        );
        if (newPaginationText !== oldPaginationText) break;
        await page.waitForTimeout(500);
        retry++;
      }
    } else {
      console.log("Next button is disabled. Reached the end.");
      hasNext = false;
    }
  } else {
    console.log("Next button not found.");
    hasNext = false;
  }

  if (pageNum > 40) hasNext = false; // safety break
}

const uniqueGigs = Array.from(new Set(allGigs));
console.log(`Total unique gigs found: ${uniqueGigs.length}`);

await Deno.writeTextFile(`${HERE}/Past Gigs Raw Data.txt`, uniqueGigs.join("\n---\n"));

const cleanList = uniqueGigs.map((g) => {
  // Data format: Date | Time | Location | Venue | Tickets
  const parts = g.split(" | ");
  return parts.length >= 4 ? `${parts[0]} - ${parts[3]} (${parts[2]})` : g;
}).join("\n");
await Deno.writeTextFile(`${HERE}/Past Gigs List.txt`, cleanList);

await browser.close();
