// CLI wrapper for the venue contact extractor (web-jam-tools#210/#935).
// Run:
//   deno task venue-contact:extract <url> [name] [city]
//   deno task venue-contact:extract --probe <venueName> [city] [address]
import { extractVenueContact, probeVenueDomains } from "./extract_venue_contact.ts";

if (import.meta.main) {
  const args = Deno.args;
  if (args.length === 0) {
    console.error(
      "Usage:\n  deno task venue-contact:extract <url> [name] [city]\n  deno task venue-contact:extract --probe <venueName> [city] [address]",
    );
    Deno.exit(1);
  }

  if (
    args[0] === "--probe" || (!args[0].startsWith("http://") && !args[0].startsWith("https://"))
  ) {
    const venueName = args[0] === "--probe" ? args[1] : args[0];
    const city = args[0] === "--probe" ? args[2] : args[1];
    const address = args[0] === "--probe" ? args[3] : args[2];
    if (!venueName) {
      console.error("Usage: deno task venue-contact:extract --probe <venueName> [city] [address]");
      Deno.exit(1);
    }
    const result = await probeVenueDomains(venueName, { city, address, name: venueName });
    if (!result) {
      console.log(
        JSON.stringify({ found: false, venueName, message: "No probed domain resolved" }, null, 2),
      );
      Deno.exit(0);
    }
    console.log(JSON.stringify(result, null, 2));
    Deno.exit(0);
  }

  const [url, name, city] = args;
  const result = await extractVenueContact(url, { name, city });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) Deno.exit(1);
}
