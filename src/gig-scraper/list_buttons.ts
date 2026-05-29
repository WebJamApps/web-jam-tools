/// <reference lib="dom" />
// Dump every button/link on joshandmariamusic.com (selector discovery helper).
// Run: deno task list:buttons
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://www.joshandmariamusic.com", { waitUntil: "networkidle" });

const buttons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button, [role="button"], a')).map((b) => ({
    tag: b.tagName,
    text: (b as HTMLElement).innerText,
    ariaLabel: b.getAttribute("aria-label"),
    id: b.id,
    className: b.className,
    dataTestId: b.getAttribute("data-testid"),
  }));
});

console.log(JSON.stringify(buttons, null, 2));
await browser.close();
