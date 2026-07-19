// CLI wrapper for the venue contact extractor (web-jam-tools#210).
// Run: deno task venue-contact:extract <url> [name] [city]
import { extractVenueContact } from "./extract_venue_contact.ts";

if (import.meta.main) {
  const [url, name, city] = Deno.args;
  if (!url) {
    console.error("Usage: deno task venue-contact:extract <url> [name] [city]");
    Deno.exit(1);
  }
  const result = await extractVenueContact(url, { name, city });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) Deno.exit(1);
}
