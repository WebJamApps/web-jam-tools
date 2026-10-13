import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildRawMessage,
  encodeHeaderWord,
  gmailSecrets,
  refreshAccessToken,
  sendEmail,
} from "../src/shared/gmail_send.ts";

function pad(s: string): string {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

function b64ToUtf8(s: string): string {
  const bin = atob(pad(s.replace(/\r?\n/g, "")));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function b64urlToUtf8(s: string): string {
  return b64ToUtf8(s.replace(/-/g, "+").replace(/_/g, "/"));
}

Deno.test("sendEmail injects a fetch and asserts one token request and one send request per email with right recipient, subject, and body", async () => {
  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.set("GMAIL_CLIENT_ID", "test-client-id");
    Deno.env.set("GMAIL_CLIENT_SECRET", "test-client-secret");
    Deno.env.set("GMAIL_REFRESH_TOKEN", "test-refresh-token");

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });

      if (urlStr === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "mock-access-token-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (urlStr === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "msg-id-abc-456" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
    };

    const recipient = "user@example.com";
    const subject = "Test Alert — Alert Subject";
    const htmlBody = "<h2>Alert</h2><p>Service is down</p>";

    const id = await sendEmail(recipient, subject, htmlBody, mockFetch);

    // Exactly one token request and one send request
    assertEquals(calls.length, 2);
    assertEquals(id, "msg-id-abc-456");

    // Check token request
    const tokenCall = calls[0];
    assertEquals(tokenCall.url, "https://oauth2.googleapis.com/token");
    assertEquals(tokenCall.init?.method, "POST");
    const tokenBody = String(tokenCall.init?.body);
    const params = new URLSearchParams(tokenBody);
    assertEquals(params.get("client_id"), "test-client-id");
    assertEquals(params.get("client_secret"), "test-client-secret");
    assertEquals(params.get("refresh_token"), "test-refresh-token");
    assertEquals(params.get("grant_type"), "refresh_token");

    // Check send request
    const sendCall = calls[1];
    assertEquals(sendCall.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assertEquals(sendCall.init?.method, "POST");
    const headers = sendCall.init?.headers as Record<string, string>;
    assertEquals(headers?.["Authorization"], "Bearer mock-access-token-123");
    assertEquals(headers?.["Content-Type"], "application/json");

    const sendPayload = JSON.parse(String(sendCall.init?.body));
    assert(sendPayload.raw, "Send payload must include raw field");

    // Decode message and verify recipients, subject, body
    const decodedMessage = b64urlToUtf8(sendPayload.raw);
    assertStringIncludes(decodedMessage, `To: ${recipient}`);
    assertMatch(decodedMessage, /Subject: =\?UTF-8\?B\?.+\?=/);
    const bodyPart = decodedMessage.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    assertStringIncludes(b64ToUtf8(bodyPart), htmlBody);
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});

Deno.test("sendEmail supports multiple recipients array", async () => {
  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.set("GMAIL_CLIENT_ID", "test-client-id");
    Deno.env.set("GMAIL_CLIENT_SECRET", "test-client-secret");
    Deno.env.set("GMAIL_REFRESH_TOKEN", "test-refresh-token");

    let capturedRaw = "";
    const mockFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "token-multi" }), { status: 200 }),
        );
      }
      if (urlStr === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        const payload = JSON.parse(String(init?.body));
        capturedRaw = payload.raw;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "msg-multi-1" }), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${urlStr}`));
    };

    const recipients = ["first@example.com", "second@example.com"];
    await sendEmail(recipients, "Multi-recipient Test", "<p>Hello</p>", mockFetch);

    const decoded = b64urlToUtf8(capturedRaw);
    assertStringIncludes(decoded, "To: first@example.com, second@example.com");
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});

Deno.test("gmailSecrets throws naming all three settings when any setting is missing", () => {
  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.delete("GMAIL_CLIENT_ID");
    Deno.env.delete("GMAIL_CLIENT_SECRET");
    Deno.env.delete("GMAIL_REFRESH_TOKEN");

    const err = (() => {
      try {
        gmailSecrets();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    assert(err !== null, "Expected gmailSecrets to throw when all settings are missing");
    assertStringIncludes(err.message, "GMAIL_CLIENT_ID");
    assertStringIncludes(err.message, "GMAIL_CLIENT_SECRET");
    assertStringIncludes(err.message, "GMAIL_REFRESH_TOKEN");

    // Partial missing settings also throw naming all three
    Deno.env.set("GMAIL_CLIENT_ID", "id-only");
    const errPartial = (() => {
      try {
        gmailSecrets();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    assert(errPartial !== null, "Expected gmailSecrets to throw when some settings are missing");
    assertStringIncludes(errPartial.message, "GMAIL_CLIENT_ID");
    assertStringIncludes(errPartial.message, "GMAIL_CLIENT_SECRET");
    assertStringIncludes(errPartial.message, "GMAIL_REFRESH_TOKEN");
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});

Deno.test("refreshAccessToken throws when token endpoint returns non-OK status", async () => {
  const mockFetch = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(new Response("invalid_grant", { status: 401 }));
  };

  await assertRejects(
    () =>
      refreshAccessToken(
        { clientId: "cid", clientSecret: "csec", refreshToken: "rtoken" },
        mockFetch,
      ),
    Error,
    "token refresh: 401 invalid_grant",
  );
});

Deno.test("sendEmail throws when Gmail send API returns non-OK status", async () => {
  const origId = Deno.env.get("GMAIL_CLIENT_ID");
  const origSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const origToken = Deno.env.get("GMAIL_REFRESH_TOKEN");

  try {
    Deno.env.set("GMAIL_CLIENT_ID", "test-client-id");
    Deno.env.set("GMAIL_CLIENT_SECRET", "test-client-secret");
    Deno.env.set("GMAIL_REFRESH_TOKEN", "test-refresh-token");

    const mockFetch = (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "mock-token" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Bad Request", { status: 400 }));
    };

    await assertRejects(
      () =>
        sendEmail(
          "recipient@example.com",
          "Subject",
          "<p>Test</p>",
          mockFetch,
        ),
      Error,
      "gmail send: 400 Bad Request",
    );
  } finally {
    if (origId) Deno.env.set("GMAIL_CLIENT_ID", origId);
    else Deno.env.delete("GMAIL_CLIENT_ID");
    if (origSecret) Deno.env.set("GMAIL_CLIENT_SECRET", origSecret);
    else Deno.env.delete("GMAIL_CLIENT_SECRET");
    if (origToken) Deno.env.set("GMAIL_REFRESH_TOKEN", origToken);
    else Deno.env.delete("GMAIL_REFRESH_TOKEN");
  }
});

Deno.test("encodeHeaderWord handles plain ASCII vs non-ASCII words", () => {
  assertEquals(encodeHeaderWord("Plain ASCII"), "Plain ASCII");
  const encoded = encodeHeaderWord("Alert — High Priority");
  assertMatch(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  const raw = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  assertStringIncludes(b64ToUtf8(raw), "Alert — High Priority");
});

Deno.test("buildRawMessage constructs valid base64url message", () => {
  const raw = buildRawMessage("to@example.com", "Subject", "<b>Body</b>");
  const decoded = b64urlToUtf8(raw);
  assertStringIncludes(decoded, "To: to@example.com");
  assertStringIncludes(decoded, "Subject: Subject");
  assertStringIncludes(decoded, 'Content-Type: text/html; charset="UTF-8"');
  assertStringIncludes(decoded, "Content-Transfer-Encoding: base64");
});
