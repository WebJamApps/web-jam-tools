// src/book-gig/html.ts — Standalone responsive Dark Mode HTML generator for /book-gig runs

import type { BookGigResult, CandidateVenue, OutreachCampaignRecord, PitchEmail } from "./types.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderStatusBadge(status: string, replyKind?: string): string {
  const s = (status || "sent").toLowerCase();
  if (replyKind === "bounce" || s === "bounced") {
    return `<span class="badge badge-bounced">bounced</span>`;
  }
  switch (s) {
    case "sent":
      return `<span class="badge badge-sent">sent</span>`;
    case "replied":
      return `<span class="badge badge-replied">replied</span>`;
    case "interested":
      return `<span class="badge badge-interested">interested</span>`;
    case "booked":
      return `<span class="badge badge-booked">booked</span>`;
    case "not-interested":
      return `<span class="badge badge-not-interested">not-interested</span>`;
    case "no-response":
      return `<span class="badge badge-no-response">no-response</span>`;
    case "target-filled":
      return `<span class="badge badge-target-filled">target-filled</span>`;
    default:
      return `<span class="badge badge-sent">${escapeHtml(s)}</span>`;
  }
}

function renderPitchCard(p: PitchEmail, idx: number): string {
  const safeVenue = escapeHtml(p.venueName);
  const safeTo = escapeHtml(p.to);
  const safeSecondary = p.secondaryTo ? escapeHtml(p.secondaryTo) : "";
  const safeSubject = escapeHtml(p.subject);
  const safePitchText = escapeHtml(p.body);
  const cardId = `pitch-body-${idx + 1}`;

  const secondaryMeta = safeSecondary
    ? `<span class="meta-secondary">(${safeSecondary})</span>`
    : "";

  return [
    `<section class="pitch-card" id="pitch-${idx + 1}">`,
    `  <header class="pitch-header">`,
    `    <div class="pitch-title-wrap">`,
    `      <span class="pitch-num">#${idx + 1}</span>`,
    `      <h3 class="pitch-venue">${safeVenue}</h3>`,
    `    </div>`,
    `    <div class="pitch-meta">`,
    `      <span class="to-label">To:</span>`,
    `      <a href="mailto:${safeTo}" class="meta-email">${safeTo}</a>`,
    `      ${secondaryMeta}`,
    `    </div>`,
    `  </header>`,
    `  <div class="pitch-subject">`,
    `    <strong>Subject:</strong> <span>${safeSubject}</span>`,
    `  </div>`,
    `  <div class="pitch-body-wrap">`,
    `    <div class="pitch-actions">`,
    `      <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('${cardId}').innerText); this.innerText='Copied!'; setTimeout(() => this.innerText='Copy Email', 2000)">`,
    `        Copy Email`,
    `      </button>`,
    `    </div>`,
    '    <pre class="pitch-body" id="' + cardId + '">' + safePitchText + "</pre>",
    `  </div>`,
    `</section>`,
  ].join("\n");
}

function renderPendingReplyCard(r: OutreachCampaignRecord, idx: number): string {
  const safeVenue = escapeHtml(r.venueName || r.venueId || "(unknown venue)");
  const safeSnippet = r.replySnippet ? escapeHtml(r.replySnippet) : "No snippet text recorded.";
  const repliedDate = r.repliedAt
    ? new Date(r.repliedAt).toLocaleDateString("en-US", { dateStyle: "medium" })
    : "Recently";

  let suggestionHtml = "";
  if (r.suggestion) {
    const s = r.suggestion;
    const intent = s.intent ? escapeHtml(s.intent) : "General Inquiry";
    const confidence = s.confidence !== undefined ? `${Math.round(s.confidence * 100)}%` : "—";
    const action = s.action ? escapeHtml(s.action) : "Review reply";
    const notes = s.notes ? escapeHtml(s.notes) : "";

    suggestionHtml = `
      <div class="suggestion-box">
        <div><strong>AI Suggestion:</strong> <span class="suggestion-action">${action}</span> (Confidence: ${confidence})</div>
        <div><strong>Detected Intent:</strong> ${intent}</div>
        ${notes ? `<div><strong>Notes:</strong> ${notes}</div>` : ""}
      </div>
    `;
  }

  return [
    `<section class="pitch-card pending-card" id="pending-reply-${idx + 1}">`,
    `  <header class="pitch-header">`,
    `    <div class="pitch-title-wrap">`,
    `      <span class="pitch-num">#${idx + 1}</span>`,
    `      <h3 class="pitch-venue">${safeVenue}</h3>`,
    `    </div>`,
    `    <div class="pitch-meta">`,
    `      ${renderStatusBadge(r.status, r.replyKind)}`,
    `      <span class="meta-date" style="margin-left: 0.5rem; color: var(--text-muted);">Replied: ${repliedDate}</span>`,
    `    </div>`,
    `  </header>`,
    `  <div class="pitch-subject">`,
    `    <strong>Response Snippet:</strong>`,
    `    <blockquote class="reply-quote">${safeSnippet}</blockquote>`,
    `  </div>`,
    suggestionHtml,
    `</section>`,
  ].join("\n");
}

export function renderDarkHtml(result: BookGigResult): string {
  const weekend = result.weekend;
  const weekendLabel = weekend
    ? escapeHtml(weekend.label || `${weekend.start} to ${weekend.end}`)
    : "All Active Campaigns";

  let locText = "All Regional Metros (~3.5h drive)";
  if (result.location) {
    if (result.location.cities && result.location.cities.length > 1) {
      const list = result.location.cities.join(", ");
      locText = result.location.includeSurrounding ? `${list} (+ surrounding)` : list;
    } else if (result.location.city) {
      const stateSuffix = result.location.state ? `, ${result.location.state}` : "";
      locText = `${result.location.city}${stateSuffix}${
        result.location.includeSurrounding ? " (+ surrounding)" : ""
      }`;
    } else {
      locText = result.location.raw;
    }
  }
  const locationLabel = escapeHtml(locText);
  const candidateCount = result.candidates.length;
  const pitchCount = result.pitches.length;
  const runDate = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });

  let heroTag = "🎵 Target Outreach Discovery";
  if (result.mode === "send" || result.batchDispatch) {
    heroTag = "🚀 Batch Outreach Dispatch";
  } else if (result.mode === "replies" || result.repliesTracking) {
    heroTag = "📬 Outreach Response & Reply Tracking";
  }

  // Hero Grid Stats
  let heroStatsHtml = "";
  if (result.repliesTracking || result.mode === "replies") {
    const checked = result.repliesTracking?.checkReplies.checked ??
      result.repliesTracking?.campaigns.length ?? 0;
    const matched = result.repliesTracking?.checkReplies.matched ?? 0;
    const pendingCount = result.repliesTracking?.pendingReplies.length ?? 0;
    heroStatsHtml = `
      <div class="stat-item">
        <span class="stat-label">Active Pitches</span>
        <span class="stat-val">${checked} tracked</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Replies Matched</span>
        <span class="stat-val">${matched} replies</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Pending Reviews</span>
        <span class="stat-val">${pendingCount} queue</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Updated</span>
        <span class="stat-val" style="font-size: 0.95rem;">${runDate}</span>
      </div>
    `;
  } else if (result.batchDispatch) {
    heroStatsHtml = `
      <div class="stat-item">
        <span class="stat-label">Target Location</span>
        <span class="stat-val">${locationLabel}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Batch Sent</span>
        <span class="stat-val" style="color: var(--badge-green-txt);">${result.batchDispatch.sent} dispatched</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Skipped</span>
        <span class="stat-val">${result.batchDispatch.skipped.length} venues</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Dispatched</span>
        <span class="stat-val" style="font-size: 0.95rem;">${runDate}</span>
      </div>
    `;
  } else {
    heroStatsHtml = `
      <div class="stat-item">
        <span class="stat-label">Target Location</span>
        <span class="stat-val">${locationLabel}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Candidates</span>
        <span class="stat-val">${candidateCount} venues</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Pitches Ready</span>
        <span class="stat-val">${pitchCount} drafts</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Generated</span>
        <span class="stat-val" style="font-size: 0.95rem;">${runDate}</span>
      </div>
    `;
  }

  // Live Campaigns Table (for replies mode or when repliesTracking exists)
  let campaignsSectionHtml = "";
  if (result.repliesTracking) {
    const campaigns = result.repliesTracking.campaigns;
    const campaignRows = campaigns.map((c: OutreachCampaignRecord, idx: number) => {
      const name = escapeHtml(c.venueName || c.venueId || "(unknown venue)");
      const loc = escapeHtml(c.location || "—");
      const statusBadge = renderStatusBadge(c.status, c.replyKind);
      const sentDate = c.sentAt
        ? new Date(c.sentAt).toLocaleDateString("en-US", { dateStyle: "short" })
        : "—";
      const snippet = escapeHtml(c.replySnippet || (c.suggestion?.notes ?? "—"));

      return `
        <tr>
          <td class="num-col">${idx + 1}</td>
          <td class="venue-name"><strong>${name}</strong></td>
          <td>${loc}</td>
          <td>${statusBadge}</td>
          <td>${sentDate}</td>
          <td class="snippet-cell">${snippet}</td>
        </tr>
      `;
    }).join("\n");

    campaignsSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">📬 Live Outreach Campaigns & Status</h2>
        <div class="table-wrap">
          <table class="candidate-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Venue Name</th>
                <th>Location</th>
                <th>Status</th>
                <th>Sent Date</th>
                <th>Last Response Snippet</th>
              </tr>
            </thead>
            <tbody>
              ${
      campaignRows ||
      '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No active outreach campaigns recorded</td></tr>'
    }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  // Pending Replies Section
  let pendingSectionHtml = "";
  if (result.repliesTracking && result.repliesTracking.pendingReplies.length > 0) {
    const pendingCards = result.repliesTracking.pendingReplies.map(renderPendingReplyCard).join(
      "\n",
    );
    pendingSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">⚠️ Pending Reply Reviews & AI Suggestions</h2>
        <div class="pitch-list">
          ${pendingCards}
        </div>
      </section>
    `;
  }

  // Batch Dispatch Section
  let batchSectionHtml = "";
  if (result.batchDispatch) {
    const b = result.batchDispatch;
    const skippedRows = b.skipped.map((s, idx) => `
      <tr>
        <td class="num-col">${idx + 1}</td>
        <td class="venue-name"><strong>${escapeHtml(s.venueName)}</strong></td>
        <td style="color: var(--badge-amber-txt);">${escapeHtml(s.reason)}</td>
      </tr>
    `).join("\n");

    batchSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">🚀 Batch Outreach Dispatch Results</h2>
        <div class="dispatch-banner">
          <p><strong>Dispatched:</strong> ${b.sent} of ${b.requested} venue pitch emails sent.</p>
          <p style="color: var(--text-secondary); font-size: 0.9rem;">Touch points logged on venue timelines and active campaigns created in MongoDB.</p>
        </div>
        ${
      b.skipped.length > 0
        ? `
          <h3 style="font-size: 1.05rem; margin: 1rem 0 0.5rem 0; color: var(--badge-amber-txt);">Skipped Venues (${b.skipped.length})</h3>
          <div class="table-wrap">
            <table class="candidate-table">
              <thead><tr><th>#</th><th>Venue Name</th><th>Reason Skipped</th></tr></thead>
              <tbody>${skippedRows}</tbody>
            </table>
          </div>
        `
        : ""
    }
      </section>
    `;
  }

  // Candidate Venues Section
  let candidatesSectionHtml = "";
  if (result.candidates.length > 0) {
    const candidateRows = result.candidates.map((c: CandidateVenue, idx: number) => {
      const loc = escapeHtml([c.city, c.usState].filter(Boolean).join(", ") || "—");
      const email = escapeHtml(c.email || "—");
      const spacing = escapeHtml(
        c.reason?.spacingNote ||
          (c.reason?.lastGigDate ? `Last: ${c.reason.lastGigDate}` : "Eligible (60+ days)"),
      );
      const isReturning = c.reason?.lastGigDate ? true : false;
      return `
        <tr>
          <td class="num-col">${idx + 1}</td>
          <td class="venue-name"><strong>${escapeHtml(c.name)}</strong></td>
          <td>${loc}</td>
          <td><a href="mailto:${email}" class="email-link">${email}</a></td>
          <td><span class="badge ${
        isReturning ? "badge-returning" : "badge-eligible"
      }">${spacing}</span></td>
        </tr>`;
    }).join("\n");

    candidatesSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">📊 Eligible Candidates</h2>
        <div class="table-wrap">
          <table class="candidate-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Venue Name</th>
                <th>Location</th>
                <th>Booking Contact</th>
                <th>Spacing Status</th>
              </tr>
            </thead>
            <tbody>
              ${candidateRows}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  // Pitches Section
  let pitchesSectionHtml = "";
  if (result.pitches.length > 0) {
    const pitchCards = result.pitches.map(renderPitchCard).join("\n");
    pitchesSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">✉️ Personalized Pitches</h2>
        <div class="pitch-list">
          ${pitchCards}
        </div>
      </section>
    `;
  } else if (!result.repliesTracking && result.candidates.length === 0) {
    pitchesSectionHtml = `
      <section class="section-block">
        <h2 class="section-title">📊 Eligible Candidates</h2>
        <div class="table-wrap">
          <table class="candidate-table">
            <thead>
              <tr><th>#</th><th>Venue Name</th><th>Location</th><th>Booking Contact</th><th>Spacing Status</th></tr>
            </thead>
            <tbody>
              <tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No venues found matching criteria</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="section-block">
        <h2 class="section-title">✉️ Personalized Pitches</h2>
        <div class="pitch-list">
          <p style="color:var(--text-muted);">No pitches drafted.</p>
        </div>
      </section>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>book-gig Outreach: ${weekendLabel}</title>
  <style>
    :root {
      --bg-primary: #121212;
      --bg-surface: #1e1e1e;
      --bg-elevated: #262626;
      --border: #333333;
      --border-accent: #444444;
      --text-primary: #f0f0f0;
      --text-secondary: #aaaaaa;
      --text-muted: #777777;
      --accent: #4fc3f7;
      --accent-hover: #81d4fa;
      --badge-green-bg: #1b3824;
      --badge-green-txt: #81c784;
      --badge-amber-bg: #3d3012;
      --badge-amber-txt: #ffd54f;
      --badge-sent-bg: #0d3c61;
      --badge-sent-txt: #4fc3f7;
      --badge-replied-bg: #3b1b61;
      --badge-replied-txt: #ce93d8;
      --badge-booked-bg: #423507;
      --badge-booked-txt: #ffe082;
      --badge-not-interested-bg: #3e2723;
      --badge-not-interested-txt: #ffab91;
      --badge-no-response-bg: #2c2c2c;
      --badge-no-response-txt: #9e9e9e;
      --badge-bounced-bg: #4a1515;
      --badge-bounced-txt: #ef9a9a;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      line-height: 1.6;
      padding: 1.5rem 1rem;
      min-height: 100vh;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
    }

    header.hero {
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem 1.75rem;
      margin-bottom: 2rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .hero-tag {
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      margin-bottom: 0.25rem;
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 0.75rem;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }

    .stat-item {
      display: flex;
      flex-direction: column;
    }

    .stat-label {
      font-size: 0.8rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .stat-val {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-top: 0.15rem;
    }

    section.section-block {
      margin-bottom: 2.5rem;
    }

    h2.section-title {
      font-size: 1.35rem;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .table-wrap {
      overflow-x: auto;
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 10px;
    }

    table.candidate-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
      text-align: left;
    }

    table.candidate-table th {
      background-color: var(--bg-elevated);
      color: var(--text-secondary);
      font-weight: 600;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
    }

    table.candidate-table td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      color: var(--text-primary);
    }

    table.candidate-table tr:last-child td {
      border-bottom: none;
    }

    table.candidate-table tr:hover td {
      background-color: rgba(255, 255, 255, 0.02);
    }

    .num-col {
      color: var(--text-muted);
      width: 40px;
    }

    .venue-name strong {
      color: #ffffff;
    }

    .snippet-cell {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
      font-size: 0.88rem;
    }

    a.email-link, a.meta-email {
      color: var(--accent);
      text-decoration: none;
    }

    a.email-link:hover, a.meta-email:hover {
      color: var(--accent-hover);
      text-decoration: underline;
    }

    .badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: 6px;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-eligible {
      background-color: var(--badge-green-bg);
      color: var(--badge-green-txt);
    }

    .badge-returning {
      background-color: var(--badge-amber-bg);
      color: var(--badge-amber-txt);
    }

    .badge-sent {
      background-color: var(--badge-sent-bg);
      color: var(--badge-sent-txt);
    }

    .badge-replied {
      background-color: var(--badge-replied-bg);
      color: var(--badge-replied-txt);
    }

    .badge-interested {
      background-color: var(--badge-green-bg);
      color: var(--badge-green-txt);
    }

    .badge-booked {
      background-color: var(--badge-booked-bg);
      color: var(--badge-booked-txt);
    }

    .badge-not-interested {
      background-color: var(--badge-not-interested-bg);
      color: var(--badge-not-interested-txt);
    }

    .badge-no-response {
      background-color: var(--badge-no-response-bg);
      color: var(--badge-no-response-txt);
    }

    .badge-target-filled {
      background-color: var(--badge-amber-bg);
      color: var(--badge-amber-txt);
    }

    .badge-bounced {
      background-color: var(--badge-bounced-bg);
      color: var(--badge-bounced-txt);
    }

    .pitch-card {
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 1.5rem;
      padding: 1.25rem;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    }

    .pending-card {
      border-left: 4px solid var(--accent);
    }

    .pitch-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border);
    }

    .pitch-title-wrap {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .pitch-num {
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--accent);
      background-color: var(--bg-elevated);
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
    }

    h3.pitch-venue {
      font-size: 1.15rem;
      font-weight: 600;
      color: #ffffff;
    }

    .pitch-meta {
      font-size: 0.9rem;
      color: var(--text-secondary);
    }

    .to-label {
      color: var(--text-muted);
      margin-right: 0.25rem;
    }

    .meta-secondary {
      color: var(--text-muted);
      margin-left: 0.25rem;
    }

    .pitch-subject {
      font-size: 0.95rem;
      color: var(--text-primary);
      margin-bottom: 0.75rem;
      padding: 0.5rem 0.75rem;
      background-color: var(--bg-elevated);
      border-radius: 6px;
    }

    .pitch-subject strong {
      color: var(--text-secondary);
      margin-right: 0.35rem;
    }

    blockquote.reply-quote {
      margin-top: 0.35rem;
      padding: 0.5rem 0.75rem;
      border-left: 3px solid var(--accent);
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 0.92rem;
      border-radius: 0 4px 4px 0;
    }

    .suggestion-box {
      background-color: var(--bg-elevated);
      border: 1px solid var(--border-accent);
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-top: 0.75rem;
      font-size: 0.88rem;
      line-height: 1.5;
    }

    .suggestion-action {
      color: var(--accent);
      font-weight: 600;
    }

    .dispatch-banner {
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-left: 4px solid var(--badge-green-txt);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
    }

    .pitch-body-wrap {
      position: relative;
    }

    .pitch-actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 0.5rem;
    }

    .copy-btn {
      background-color: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-accent);
      border-radius: 6px;
      padding: 0.35rem 0.75rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease-in-out;
    }

    .copy-btn:hover {
      background-color: var(--accent);
      color: #121212;
      border-color: var(--accent);
    }

    pre.pitch-body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      font-family: var(--font-mono);
      font-size: 0.9rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
    }

    @media (max-width: 600px) {
      body {
        padding: 0.75rem 0.5rem;
      }

      header.hero {
        padding: 1rem;
      }

      h1 {
        font-size: 1.35rem;
      }

      .hero-grid {
        grid-template-columns: 1fr 1fr;
      }

      .pitch-header {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div class="hero-tag">${heroTag}</div>
      <h1>${weekendLabel}</h1>
      <div class="hero-grid">
        ${heroStatsHtml}
      </div>
    </header>

    <main>
      ${pendingSectionHtml}
      ${campaignsSectionHtml}
      ${batchSectionHtml}
      ${candidatesSectionHtml}
      ${pitchesSectionHtml}
    </main>

    <footer>
      Generated by <code>/book-gig</code> • WebJamApps Music Outreach Engine
    </footer>
  </div>
</body>
</html>`;
}
