import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapError as hsMapError,
  normalizeAmount,
  normalizeCloseDate,
  normalizeField,
  parseRetryAfter,
  toHubSpotDate,
  toHubSpotProps,
  toSnapshot,
} from "../../src/adapters/hubspot/real.js";
import {
  b64url,
  buildRaw,
  decodeB64url,
  decodeHeader,
  encodeHeader,
  findTextPlain,
  mapError as gmMapError,
  normalizeBody,
  retryAfterMs,
} from "../../src/adapters/gmail/real.js";
import { TransientError } from "../../src/adapters/types.js";

afterEach(() => {
  vi.useRealTimers();
});

const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const headerLines = (raw: string) => decodeRaw(raw).split("\r\n\r\n")[0].split("\r\n");

// =====================================================================
// HubSpot pure helpers
// =====================================================================

describe("hubspot / toHubSpotDate", () => {
  it("converts YYYY-MM-DD to midnight UTC epoch ms", () => {
    expect(toHubSpotDate("2024-10-15")).toBe(String(Date.parse("2024-10-15T00:00:00.000Z")));
    expect(toHubSpotDate("2024-10-15")).toBe("1728950400000");
    expect(toHubSpotDate("1970-01-01")).toBe("0");
  });

  it("passes through anything that is not exactly YYYY-MM-DD", () => {
    expect(toHubSpotDate("1728950400000")).toBe("1728950400000");
    expect(toHubSpotDate("2024-10-15T12:00:00Z")).toBe("2024-10-15T12:00:00Z");
    expect(toHubSpotDate("")).toBe("");
    expect(toHubSpotDate("next friday")).toBe("next friday");
  });

  it("never produces the string 'NaN' for a well-formed-looking but impossible date", () => {
    // BUG: "2024-13-45" matches the shape test, Date.parse returns NaN and the
    // literal string "NaN" is written to the HubSpot closedate property.
    expect(toHubSpotDate("2024-13-45")).not.toBe("NaN");
    expect(toHubSpotDate("2024-02-31")).not.toBe("NaN");
  });
});

describe("hubspot / normalizeCloseDate", () => {
  it("normalizes the shapes HubSpot returns", () => {
    expect(normalizeCloseDate("2024-10-15")).toBe("2024-10-15");
    expect(normalizeCloseDate("2024-10-15T00:00:00Z")).toBe("2024-10-15");
    expect(normalizeCloseDate("2024-10-15T23:59:59.999Z")).toBe("2024-10-15");
    expect(normalizeCloseDate("1728950400000")).toBe("2024-10-15");
    expect(normalizeCloseDate("0")).toBe("1970-01-01");
  });

  it("returns unparseable input unchanged", () => {
    expect(normalizeCloseDate("soon")).toBe("soon");
    expect(normalizeCloseDate("")).toBe("");
  });

  it("does not throw on an out-of-range epoch value", () => {
    // BUG: new Date(1e16).toISOString() throws RangeError: Invalid time value.
    // A junk closedate read back from HubSpot crashes the whole reconcile run.
    expect(() => normalizeCloseDate("9999999999999999")).not.toThrow();
  });
});

describe("hubspot / normalizeAmount", () => {
  it("strips trailing fraction zeros so HubSpot values compare equal to compiled ones", () => {
    expect(normalizeAmount("42000")).toBe("42000");
    expect(normalizeAmount("42000.00")).toBe("42000");
    expect(normalizeAmount("42000.00000")).toBe("42000");
    expect(normalizeAmount("42000.")).toBe("42000");
    expect(normalizeAmount("42000.50")).toBe("42000.5");
    expect(normalizeAmount("42000.05")).toBe("42000.05");
    expect(normalizeAmount("  42000.10  ")).toBe("42000.1");
    expect(normalizeAmount("-500.10")).toBe("-500.1");
    expect(normalizeAmount("0.00")).toBe("0");
  });

  it("passes through values it cannot parse rather than corrupting them", () => {
    expect(normalizeAmount("42,000")).toBe("42,000");
    expect(normalizeAmount("$42000")).toBe("$42000");
    expect(normalizeAmount("1e3")).toBe("1e3");
    expect(normalizeAmount("")).toBe("");
    expect(normalizeAmount("abc")).toBe("abc");
  });
});

describe("hubspot / normalizeField", () => {
  it("maps empty and nullish values to null", () => {
    expect(normalizeField("amount", null)).toBeNull();
    expect(normalizeField("amount", undefined)).toBeNull();
    expect(normalizeField("amount", "")).toBeNull();
    expect(normalizeField("dealname", "")).toBeNull();
  });

  it("routes only closedate and amount through their normalizers", () => {
    expect(normalizeField("closedate", "2024-10-15T00:00:00Z")).toBe("2024-10-15");
    expect(normalizeField("amount", "42000.00")).toBe("42000");
    expect(normalizeField("dealname", "  Acme  ")).toBe("  Acme  ");
    expect(normalizeField("dealstage", "contractsent")).toBe("contractsent");
    expect(normalizeField("hs_next_step", "42000.00")).toBe("42000.00");
  });
});

describe("hubspot / toHubSpotProps", () => {
  it("emits only known deal fields, skipping undefined and keeping empty strings", () => {
    const props = toHubSpotProps({ dealname: "Acme", amount: "42000", closedate: undefined, hs_next_step: "" });
    expect(props).toEqual({ dealname: "Acme", amount: "42000", hs_next_step: "" });
  });

  it("drops unknown keys so no unexpected property is written to the CRM", () => {
    const props = toHubSpotProps({ dealname: "Acme", amend_thread_key: "hack", pipeline: "x" } as never);
    expect(Object.keys(props)).toEqual(["dealname"]);
  });

  it("converts closedate but leaves an empty closedate as a clear", () => {
    expect(toHubSpotProps({ closedate: "2024-10-15" })).toEqual({ closedate: "1728950400000" });
    expect(toHubSpotProps({ closedate: "" })).toEqual({ closedate: "" });
  });

  it("never writes 'NaN' as a closedate", () => {
    // BUG: same root cause as toHubSpotDate — an impossible date becomes "NaN".
    expect(toHubSpotProps({ closedate: "2024-13-45" }).closedate).not.toBe("NaN");
  });
});

describe("hubspot / toSnapshot", () => {
  const base = { id: "D1", properties: { dealname: "Acme", amount: "42000.00", closedate: "1728950400000", dealstage: "contractsent", hs_next_step: "" } };

  it("normalizes every deal field and maps blanks to null", () => {
    expect(toSnapshot(base).fields).toEqual({
      dealname: "Acme",
      amount: "42000",
      closedate: "2024-10-15",
      dealstage: "contractsent",
      hs_next_step: null,
    });
  });

  it("tolerates a response with no properties at all", () => {
    const snap = toSnapshot({ id: "D1" } as never);
    expect(snap.id).toBe("D1");
    expect(Object.values(snap.fields).every((v) => v === null)).toBe(true);
    expect(snap.lastChangedBy).toEqual({});
  });

  it("picks the newest propertiesWithHistory entry regardless of input order", () => {
    const snap = toSnapshot({
      ...base,
      propertiesWithHistory: {
        amount: [
          { sourceType: "INTEGRATION", updatedByUserId: 1, timestamp: "2024-01-01T00:00:00.000Z" },
          { sourceType: "CRM_UI", updatedByUserId: 77, timestamp: "2024-06-01T00:00:00.000Z" },
          { sourceType: "API", updatedByUserId: 2, timestamp: "2024-03-01T00:00:00.000Z" },
        ],
      },
    });
    expect(snap.lastChangedBy.amount).toEqual({ sourceType: "CRM_UI", userId: "77", at: "2024-06-01T00:00:00.000Z" });
  });

  it("accepts Date timestamps and a userId of 0", () => {
    const snap = toSnapshot({
      ...base,
      propertiesWithHistory: {
        dealname: [
          { sourceType: "CRM_UI", updatedByUserId: 0, timestamp: new Date("2024-06-02T03:04:05.000Z") },
          { sourceType: "API", timestamp: new Date("2024-01-02T00:00:00.000Z") },
        ],
      },
    });
    expect(snap.lastChangedBy.dealname).toEqual({ sourceType: "CRM_UI", userId: "0", at: "2024-06-02T03:04:05.000Z" });
  });

  it("omits lastChangedBy when history is missing, empty, or for another field", () => {
    const snap = toSnapshot({ ...base, propertiesWithHistory: { amount: [], hs_lastmodifieddate: [{ sourceType: "API", timestamp: "2024-01-01T00:00:00.000Z" }] } });
    expect(snap.lastChangedBy).toEqual({});
  });

  it("omits userId when HubSpot reports no user (automation)", () => {
    const snap = toSnapshot({ ...base, propertiesWithHistory: { amount: [{ sourceType: "AUTOMATION_PLATFORM", timestamp: "2024-06-01T00:00:00.000Z" }] } });
    expect(snap.lastChangedBy.amount).toEqual({ sourceType: "AUTOMATION_PLATFORM", at: "2024-06-01T00:00:00.000Z" });
    expect("userId" in snap.lastChangedBy.amount!).toBe(false);
  });
});

describe("hubspot / parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 12 ")).toBe(12_000);
  });

  it("never returns a negative wait", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("returns 0 for missing or unparseable values", () => {
    expect(parseRetryAfter(undefined)).toBe(0);
    expect(parseRetryAfter("")).toBe(0);
    expect(parseRetryAfter("soon")).toBe(0);
    expect(parseRetryAfter("Infinity")).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    expect(parseRetryAfter("Mon, 01 Jan 2024 00:02:00 GMT")).toBe(120_000);
    expect(parseRetryAfter("Sun, 31 Dec 2023 23:00:00 GMT")).toBe(0);
  });
});

describe("hubspot / mapError", () => {
  const catchOf = (err: unknown) => {
    try {
      hsMapError(err, "updateDeal");
      throw new Error("mapError did not throw");
    } catch (e) {
      return e;
    }
  };

  it("turns 429 into a TransientError carrying retry-after", () => {
    const e = catchOf({ code: 429, headers: { "Retry-After": "30" } }) as TransientError;
    expect(e).toBeInstanceOf(TransientError);
    expect(e.retryAfterMs).toBe(30_000);
    expect(e.message).toContain("HTTP 429");
  });

  it("reads retry-after from a Headers-like object case-insensitively", () => {
    const e = catchOf({ code: 429, headers: new Headers({ "retry-after": "5" }) }) as TransientError;
    expect(e.retryAfterMs).toBe(5_000);
  });

  it("turns every 5xx into a TransientError with no retry hint", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const e = catchOf({ code: status }) as TransientError;
      expect(e).toBeInstanceOf(TransientError);
      expect(e.retryAfterMs).toBe(0);
    }
  });

  it("rethrows 4xx (other than 429) unchanged, preserving identity", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 499]) {
      const original = Object.assign(new Error("bad"), { code: status });
      expect(catchOf(original)).toBe(original);
    }
  });

  it("classifies node network failures as transient", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"]) {
      expect(catchOf(Object.assign(new Error("net"), { code }))).toBeInstanceOf(TransientError);
    }
    expect(catchOf(Object.assign(new Error("nope"), { cause: { code: "ECONNRESET" } }))).toBeInstanceOf(TransientError);
    expect(catchOf(Object.assign(new Error("fetch failed")))).toBeInstanceOf(TransientError);
    expect(catchOf(Object.assign(new Error("x"), { name: "FetchError" }))).toBeInstanceOf(TransientError);
  });

  it("rethrows a plain programming error unchanged", () => {
    const original = new TypeError("obj.foo is not a function");
    expect(catchOf(original)).toBe(original);
  });

  it("treats a real aborted/timed-out request as transient", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(abort.code).toBe(20);
    // BUG: httpStatus() sees the DOMException's numeric `.code` (20) and treats it as
    // an HTTP status, so the AbortError/network branch is never reached and an aborted
    // HubSpot write is reported as a permanent failure instead of being retried.
    expect(catchOf(abort)).toBeInstanceOf(TransientError);
  });
});

// =====================================================================
// Gmail pure helpers
// =====================================================================

describe("gmail / buildRaw", () => {
  it("builds a well-formed RFC 822 message with the body base64-encoded", () => {
    const raw = buildRaw({ to: "priya@acme.com", subject: "Proposal", body: "Hi Priya,\n\nHere it is.\n" }, "rep@corp.com");
    const text = decodeRaw(raw);
    const [head, ...bodyParts] = text.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "From: rep@corp.com",
      "To: priya@acme.com",
      "Subject: Proposal",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(bodyParts.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hi Priya,\n\nHere it is.\n");
  });

  it("omits From, X-Amend-Op and In-Reply-To when not supplied", () => {
    const lines = headerLines(buildRaw({ to: "a@b.com", subject: "S", body: "B" }));
    expect(lines.some((l) => l.startsWith("From:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("X-Amend-Op:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("In-Reply-To:"))).toBe(false);
  });

  it("adds In-Reply-To and References together for a threaded correction", () => {
    const lines = headerLines(buildRaw({ to: "a@b.com", subject: "Re: S", body: "B", amendOpId: "op-1", inReplyTo: { rfcMessageId: "<x@mail.gmail.com>" } }));
    expect(lines).toContain("X-Amend-Op: op-1");
    expect(lines).toContain("In-Reply-To: <x@mail.gmail.com>");
    expect(lines).toContain("References: <x@mail.gmail.com>");
  });

  it("wraps the base64 body at 76 characters and round-trips unicode", () => {
    const body = `Hi ☃,\n${"x".repeat(500)}\nBest regards`;
    const text = decodeRaw(buildRaw({ to: "a@b.com", subject: "S", body }));
    const encoded = text.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    for (const l of encoded.split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(body);
  });

  it("neutralizes CRLF in the subject via RFC 2047 encoding", () => {
    const lines = headerLines(buildRaw({ to: "a@b.com", subject: "Proposal\r\nBcc: attacker@evil.com", body: "B" }));
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
    expect(lines.filter((l) => l.startsWith("Subject:"))).toHaveLength(1);
  });

  it("does not let a recipient string inject extra headers", () => {
    const lines = headerLines(buildRaw({ to: "priya@acme.com\r\nBcc: attacker@evil.com", subject: "S", body: "B" }));
    // BUG (security): `To: ${content.to}` is interpolated raw, so a CRLF in the
    // recipient injects arbitrary headers — here a silent Bcc that exfiltrates every
    // email Amend sends. `to` comes from the LLM-extracted contact_email fact.
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
  });

  it("does not let X-Amend-Op or In-Reply-To inject extra headers", () => {
    const lines = headerLines(
      buildRaw({
        to: "a@b.com",
        subject: "S",
        body: "B",
        amendOpId: "op\r\nBcc: a@evil.com",
        inReplyTo: { rfcMessageId: "<x>\r\nBcc: b@evil.com" },
      }),
    );
    // BUG (security): same raw interpolation for X-Amend-Op / In-Reply-To / References.
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
  });

  it("does not let the configured From address inject extra headers", () => {
    const lines = headerLines(buildRaw({ to: "a@b.com", subject: "S", body: "B" }, "me@corp.com\r\nBcc: c@evil.com"));
    // BUG (security): `From: ${from}` is interpolated raw (GMAIL_FROM env value).
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
  });

  it("keeps every header line within the RFC 5322 998-octet limit", () => {
    const lines = headerLines(buildRaw({ to: "a@b.com", subject: `Proposal ${"long ".repeat(300)}`, body: "B" }));
    // BUG: a long pure-ASCII subject skips encodeHeader's folding entirely and is
    // emitted as one unfolded header line well over the 998-octet limit.
    for (const l of lines) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(998);
  });
});

describe("gmail / encodeHeader + decodeHeader", () => {
  const samples = [
    "Proposal for Acme",
    "Proposition pour Café Ünicorn",
    "提案書：エーコーポレーション様",
    "Proposal 🎉 for Acme 🚀 — Q4 renewal ✅",
    "Ünicorn ".repeat(30),
    "🎉".repeat(40),
    "混合 mixed ASCII と日本語 and emoji 🎯 in one long subject line that keeps going and going",
  ];

  it("round-trips through decodeHeader", () => {
    for (const s of samples) expect(decodeHeader(encodeHeader(s))).toBe(s);
  });

  it("leaves pure printable ASCII untouched", () => {
    expect(encodeHeader("Proposal for Acme Corp - Q4")).toBe("Proposal for Acme Corp - Q4");
    expect(encodeHeader("")).toBe("");
  });

  it("emits encoded-words no longer than 75 characters", () => {
    for (const s of samples) {
      for (const word of encodeHeader(s).split("\r\n ")) {
        if (!word.startsWith("=?")) continue;
        expect(word.length).toBeLessThanOrEqual(75);
      }
    }
  });

  it("never splits a code point across encoded-words", () => {
    for (const s of samples) {
      const enc = encodeHeader(s);
      if (!enc.startsWith("=?")) continue;
      for (const word of enc.split("\r\n ")) {
        const b64 = word.slice("=?UTF-8?B?".length, -"?=".length);
        expect(Buffer.from(b64, "base64").toString("utf8")).not.toContain("�");
      }
    }
  });

  it("folds long values with CRLF + a single leading space", () => {
    const enc = encodeHeader("🎉".repeat(40));
    expect(enc.split("\r\n ").length).toBeGreaterThan(1);
    expect(enc).not.toContain("\r\n\r\n");
    for (const line of enc.split("\r\n")) expect(line.startsWith(" ") || line.startsWith("=?")).toBe(true);
  });

  it("decodes Q-encoding, underscores, latin1 and mixed plain text", () => {
    expect(decodeHeader("=?UTF-8?Q?Caf=C3=A9_time?=")).toBe("Café time");
    expect(decodeHeader("=?ISO-8859-1?Q?Caf=E9?=")).toBe("Café");
    expect(decodeHeader("=?utf-8?b?SGVsbG8=?=")).toBe("Hello");
    expect(decodeHeader("Plain subject, untouched")).toBe("Plain subject, untouched");
    expect(decodeHeader("Hi =?UTF-8?B?4piD?= there")).toBe("Hi ☃ there");
    expect(decodeHeader("")).toBe("");
  });

  it("joins adjacent encoded-words across a fold without inserting whitespace", () => {
    expect(decodeHeader("=?UTF-8?B?4piD?=\r\n =?UTF-8?B?4piD?=")).toBe("☃☃");
    expect(decodeHeader("=?UTF-8?B?4piD?=   =?UTF-8?B?4piD?=")).toBe("☃☃");
  });
});

describe("gmail / findTextPlain", () => {
  const plain = (data: string, mimeType = "text/plain") => ({ mimeType, body: { data } });

  it("finds text/plain in a multipart/alternative regardless of order", () => {
    const first = { mimeType: "multipart/alternative", parts: [plain("cGxhaW4="), plain("PGI+aGk8L2I+", "text/html")] };
    const second = { mimeType: "multipart/alternative", parts: [plain("PGI+aGk8L2I+", "text/html"), plain("cGxhaW4=")] };
    expect(findTextPlain(first)?.body?.data).toBe("cGxhaW4=");
    expect(findTextPlain(second)?.body?.data).toBe("cGxhaW4=");
  });

  it("descends into a nested multipart/mixed > multipart/alternative", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [plain("Ym9keQ=="), plain("PGI+aGk8L2I+", "text/html")] },
        { mimeType: "application/pdf", body: { attachmentId: "att-1" } },
      ],
    };
    expect(findTextPlain(payload as never)?.body?.data).toBe("Ym9keQ==");
  });

  it("skips a text/plain part with no inline data and keeps looking", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { attachmentId: "att-1", size: 10 } },
        { mimeType: "multipart/alternative", parts: [plain("Ym9keQ==")] },
      ],
    };
    expect(findTextPlain(payload as never)?.body?.data).toBe("Ym9keQ==");
  });

  it("matches a parameterized, upper-cased mime type", () => {
    expect(findTextPlain({ mimeType: "TEXT/PLAIN; charset=UTF-8", body: { data: "eA==" } })?.body?.data).toBe("eA==");
  });

  it("returns undefined for undefined, html-only, and empty payloads", () => {
    expect(findTextPlain(undefined)).toBeUndefined();
    expect(findTextPlain({ mimeType: "text/html", body: { data: "eA==" } })).toBeUndefined();
    expect(findTextPlain({ mimeType: "multipart/alternative", parts: [] })).toBeUndefined();
  });

  it("returns the first text/plain in depth-first order", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [plain("Zmlyc3Q=")] }, plain("c2Vjb25k")],
    };
    expect(decodeB64url(findTextPlain(payload as never)!.body!.data!)).toBe("first");
  });
});

describe("gmail / normalizeBody", () => {
  it("converts CRLF to LF and trims trailing whitespace only", () => {
    expect(normalizeBody("a\r\nb\r\n")).toBe("a\nb");
    expect(normalizeBody("a\n\nb\n\n\n  \t ")).toBe("a\n\nb");
    expect(normalizeBody("  leading kept\n")).toBe("  leading kept");
    expect(normalizeBody("")).toBe("");
    expect(normalizeBody("\r\n\r\n")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizeBody("Hi\r\n\r\nBest regards\r\n");
    expect(normalizeBody(once)).toBe(once);
  });
});

describe("gmail / b64url", () => {
  it("round-trips at every padding length and is url-safe", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "abcde", "☃ 日本語 🎉", "?>?>?>", "\u0000\u0001"]) {
      const enc = b64url(Buffer.from(s, "utf8"));
      expect(enc).not.toMatch(/[+/=]/);
      expect(decodeB64url(enc)).toBe(s);
    }
  });

  it("decodes padded standard base64 too", () => {
    expect(decodeB64url("SGVsbG8=")).toBe("Hello");
    expect(decodeB64url("SGVsbG8")).toBe("Hello");
  });
});

describe("gmail / retryAfterMs", () => {
  it("reads retry-after from a Headers object and a plain object", () => {
    expect(retryAfterMs({ response: { headers: new Headers({ "retry-after": "7" }) } })).toBe(7_000);
    expect(retryAfterMs({ response: { headers: { "Retry-After": "7" } } })).toBe(7_000);
    expect(retryAfterMs({ response: { headers: { "retry-after": ["7"] } } })).toBe(7_000);
  });

  it("returns 0 when there is no header, no response, or an unparseable value", () => {
    expect(retryAfterMs(undefined)).toBe(0);
    expect(retryAfterMs({})).toBe(0);
    expect(retryAfterMs({ response: {} })).toBe(0);
    expect(retryAfterMs({ response: { headers: {} } })).toBe(0);
    expect(retryAfterMs({ response: { headers: { "retry-after": "later" } } })).toBe(0);
    expect(retryAfterMs({ response: { headers: { "retry-after": "-9" } } })).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    expect(retryAfterMs({ response: { headers: { "retry-after": "Mon, 01 Jan 2024 00:00:45 GMT" } } })).toBe(45_000);
  });
});

describe("gmail / mapError", () => {
  const catchOf = (err: unknown) => {
    try {
      gmMapError(err, "sendDraft");
      throw new Error("mapError did not throw");
    } catch (e) {
      return e;
    }
  };

  it("maps 429 and 5xx to TransientError with the retry hint", () => {
    const e = catchOf({ response: { status: 429, headers: { "retry-after": "3" } } }) as TransientError;
    expect(e).toBeInstanceOf(TransientError);
    expect(e.retryAfterMs).toBe(3_000);
    for (const status of [500, 502, 503]) expect(catchOf({ response: { status } })).toBeInstanceOf(TransientError);
  });

  it("reads the status from response.status, status, numeric code and 3-digit string code", () => {
    expect(catchOf({ response: { status: 503 } })).toBeInstanceOf(TransientError);
    expect(catchOf({ status: 503 })).toBeInstanceOf(TransientError);
    expect(catchOf({ code: 503 })).toBeInstanceOf(TransientError);
    expect(catchOf({ code: "503" })).toBeInstanceOf(TransientError);
  });

  it("treats 403 rateLimitExceeded as transient but 403 permission denials as permanent", () => {
    expect(catchOf(Object.assign(new Error("Rate Limit Exceeded"), { code: 403 }))).toBeInstanceOf(TransientError);
    expect(catchOf(Object.assign(new Error("User-rate limit exceeded"), { code: 403 }))).toBeInstanceOf(TransientError);
    expect(catchOf(Object.assign(new Error("rateLimitExceeded"), { code: 403 }))).toBeInstanceOf(TransientError);
    const denied = Object.assign(new Error("Insufficient Permission"), { code: 403 });
    expect(catchOf(denied)).toBe(denied);
  });

  it("rethrows 400/401/404 unchanged", () => {
    for (const status of [400, 401, 404]) {
      const original = Object.assign(new Error("bad"), { response: { status } });
      expect(catchOf(original)).toBe(original);
    }
  });

  it("classifies node network failures as transient", () => {
    expect(catchOf(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeInstanceOf(TransientError);
    expect(catchOf(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBeInstanceOf(TransientError);
    expect(catchOf(new Error("socket hang up"))).toBeInstanceOf(TransientError);
    const bug = new TypeError("cannot read properties of undefined");
    expect(catchOf(bug)).toBe(bug);
  });

  it("treats a real aborted/timed-out request as transient", () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    // BUG: identical to the HubSpot adapter — DOMException.code === 20 is mistaken for
    // an HTTP status, so the AbortError branch is unreachable and the send is reported
    // as permanently failed instead of retried.
    expect(catchOf(abort)).toBeInstanceOf(TransientError);
  });
});
