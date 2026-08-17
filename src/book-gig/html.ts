// src/book-gig/html.ts — Standalone responsive Dark Mode HTML generator for /book-gig runs

import type { BookGigResult, CandidateVenue, PitchEmail } from "./types.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderDarkHtml(result: BookGigResult): string {
  const weekend = result.weekend;
  const weekendLabel = escapeHtml(weekend.label || `${weekend.start} to ${weekend.end}`);
  const locationLabel = result.location
    ? escapeHtml(
      result.location.city
        ? `${result.location.city}, ${result.location.state || ""}`
        : result.location.raw,
    )
    : "All Regional Metros (~3.5h drive)";
  const candidateCount = result.candidates.length;
  const pitchCount = result.pitches.length;
  const runDate = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });

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

  const pitchCards = result.pitches.map((p: PitchEmail, idx: number) => {
    const venueName = escapeHtml(p.venueName);
    const toEmail = escapeHtml(p.to);
    const secondaryEmail = p.secondaryTo ? escapeHtml(p.secondaryTo) : null;
    const subject = escapeHtml(p.subject);
    const body = escapeHtml(p.body);
    const cardId = `pitch-body-${idx + 1}`;

    return `
      <section class="pitch-card" id="pitch-${idx + 1}">
        <header class="pitch-header">
          <div class="pitch-title-wrap">
            <span class="pitch-num">#${idx + 1}</span>
            <h3 class="pitch-venue">${venueName}</h3>
          </div>
          <div class="pitch-meta">
            <span class="to-label">To:</span>
            <a href="mailto:${toEmail}" class="meta-email">${toEmail}</a>
            ${secondaryEmail ? `<span class="meta-secondary">(${secondaryEmail})</span>` : ""}
          </div>
        </header>

        <div class="pitch-subject">
          <strong>Subject:</strong> <span>${subject}</span>
        </div>

        <div class="pitch-body-wrap">
          <div class="pitch-actions">
            <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('${cardId}').innerText); this.innerText='Copied!'; setTimeout(() => this.innerText='Copy Email', 2000)">
              Copy Email
            </button>
          </div>
          <pre class="pitch-body" id="${cardId}">${body}</pre>
        </div>
      </section>`;
  }).join("\n");

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
    }

    .badge-eligible {
      background-color: var(--badge-green-bg);
      color: var(--badge-green-txt);
    }

    .badge-returning {
      background-color: var(--badge-amber-bg);
      color: var(--badge-amber-txt);
    }

    .pitch-card {
      background-color: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 1.5rem;
      padding: 1.25rem;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
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
      <div class="hero-tag">🎵 Target Outreach Discovery</div>
      <h1>${weekendLabel}</h1>
      <div class="hero-grid">
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
      </div>
    </header>

    <main>
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
              ${
    candidateRows ||
    '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No venues found matching criteria</td></tr>'
  }
            </tbody>
          </table>
        </div>
      </section>

      <section class="section-block">
        <h2 class="section-title">✉️ Personalized Pitches</h2>
        <div class="pitch-list">
          ${pitchCards || '<p style="color:var(--text-muted);">No pitches drafted.</p>'}
        </div>
      </section>
    </main>

    <footer>
      Generated by <code>/book-gig</code> • WebJamApps Music Outreach Engine
    </footer>
  </div>
</body>
</html>`;
}
