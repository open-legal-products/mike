// Regression proof for the shell's fixed flows (see desktop-fix-spec): drives
// the packaged Mike.app over CDP and asserts, one by one, the behaviors the
// window-open / navigation / download rework promises:
//
//   a. OAuth popup mechanics — window.open("about:blank","mike_mcp_oauth")
//      yields a real in-shell popup with a live window.opener back-channel
//      that survives a cross-origin hop, and the popup gets NO mikeDesktop
//      bridge (a third-party consent page must never see privileged APIs).
//   b. External links still bounce to the system browser (captured to a file
//      via MIKE_E2E_CAPTURE_EXTERNAL, so no real tabs open) and never spawn
//      an in-shell window.
//   c. A file: navigation of the main window is blocked (drop hijack fix).
//   d. A failing iframe does NOT kick the session to the connect screen
//      (did-fail-load must ignore subframes).
//   e. Blob downloads (settings → export account JSON) are picked up by the
//      shell's will-download handler, targeting MIKE_DOWNLOAD_DIR with no
//      save dialog.
//   f. Presigned-URL document downloads (DocTable downloadDoc: foreign-origin
//      anchor click) are resolved by the will-navigate → probe → downloadURL
//      path into the shell's download handler — not bounced to the browser.
//
// Download assertions read MIKE_E2E_DOWNLOAD_LOG (a JSONL file the shell's
// will-download handler appends to), NOT the download directory: an attached
// Playwright session installs its own browser-level CDP download behavior,
// which diverts the actual bytes away from setSavePath. The unattended
// save-to-dir path is exercised by the handler itself (state + savePath are
// what it logged); the log proves the download stayed in-shell.
//
// Prereqs: the docker-compose stack is up and the app has been packaged
// (npm run dist). Run from desktop/:
//   node e2e/flows.e2e.mjs
//   MIKE_E2E_URL=http://localhost:3100 MIKE_E2E_API=http://localhost:3101 \
//     node e2e/flows.e2e.mjs                                # shifted stack
//
// Every step is attempted even after a failure (failures are collected and
// the process exits non-zero at the end), each step screenshots on failure,
// and the run never touches the user's real settings.json/~/Downloads/browser
// (per-run download dir + external-URL capture file under e2e/artifacts/).

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeOnboardingIfRequired,
  dismissFirstRunOverlay,
  packagedAppBinary,
  signUpThroughUi,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_BINARY = packagedAppBinary(path.join(here, ".."));
const ARTIFACTS = path.join(here, "artifacts");
const SERVER_URL = (process.env.MIKE_E2E_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const API_URL = (process.env.MIKE_E2E_API ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);
const CDP_PORT = 9224; // distinct from app.e2e.mjs so both suites can coexist
const RUN_ID = Date.now().toString(36);
const EMAIL = `desktop-flows-${RUN_ID}@example.com`;
const PASSWORD = `E2e!${RUN_ID}aA1`;
// Per-run dirs/files: "a new file appeared" assertions start from a known-empty
// download dir, and the capture file can't be polluted by a previous run.
const DOWNLOAD_DIR = path.join(ARTIFACTS, `downloads-flows-${RUN_ID}`);
const CAPTURE_FILE = path.join(ARTIFACTS, `external-flows-${RUN_ID}.txt`);
const DOWNLOAD_LOG = path.join(ARTIFACTS, `download-log-${RUN_ID}.jsonl`);
// Isolated userData so the run never touches the developer's real settings /
// window bounds and never collides with a running Mike.app on the instance
// lock (see MIKE_USER_DATA_DIR in main.js).
const USER_DATA_DIR = path.join(ARTIFACTS, `userdata-flows-${RUN_ID}`);
const PDF_FIXTURE = path.join(here, "..", "..", "e2e", "fixtures", "test.pdf");
const DOC_BASE = `e2e-doc-${RUN_ID}`;
const DOC_NAME = `${DOC_BASE}.pdf`;
const EXTERNAL_URL = "https://example.com/mike-e2e-external";

mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("CDP endpoint never came up — did the app launch?");
}

const shot = async (page, name) => {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
    console.log(`  📸 ${name}`);
  } catch {
    /* page may be gone */
  }
};

// Poll for a truthy result; the async source of truth for most assertions here
// is "eventually the shell did X", so raw sleeps are kept to the negative
// assertions only.
async function waitFor(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

// New CDP targets (popup BrowserWindows) surface as new pages in the shared
// context; devtools targets are noise.
const livePages = (context) =>
  context.pages().filter((p) => !p.url().startsWith("devtools"));

async function waitForNewPage(context, before, timeoutMs) {
  return waitFor(
    () => livePages(context).find((p) => !before.has(p)) ?? null,
    timeoutMs,
  );
}

const readDownloadLog = () => {
  try {
    return readFileSync(DOWNLOAD_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

// A download "landed" when the shell's will-download handler logged a fresh
// completed entry (see the header for why the directory itself can't be
// watched while Playwright is attached).
async function waitForDownloadLogged(countBefore, timeoutMs) {
  return waitFor(
    () =>
      readDownloadLog()
        .slice(countBefore)
        .find((e) => e.state === "completed") ?? null,
    timeoutMs,
    500,
  );
}

const failures = [];
let stepNo = 0;
async function step(name, page, fn) {
  stepNo += 1;
  const tag = String(stepNo).padStart(2, "0");
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push({ step: name, error: err.message });
    console.error(`FAIL ${name}: ${err.message}`);
    await shot(page, `flows-${tag}-FAIL`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const app = spawn(
  APP_BINARY,
  [`--remote-debugging-port=${CDP_PORT}`, `--server-url=${SERVER_URL}`],
  {
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      MIKE_DOWNLOAD_DIR: DOWNLOAD_DIR,
      MIKE_E2E_CAPTURE_EXTERNAL: CAPTURE_FILE,
      MIKE_E2E_DOWNLOAD_LOG: DOWNLOAD_LOG,
      MIKE_USER_DATA_DIR: USER_DATA_DIR,
    },
  },
);

let browser;
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools"));
  if (!page) throw new Error("no app page found over CDP");

  // ── Sign in: fresh signup through the product UI (same approach as
  //    app.e2e.mjs; the local stack autoconfirms). The shell persists sessions
  //    across launches, so reset to anonymous first.
  await step("signed up + signed in", page, async () => {
    await page.waitForURL((url) => url.href.startsWith(SERVER_URL), {
      timeout: 15_000,
    });
    if (!/\/login/.test(page.url())) {
      await context.clearCookies();
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(`${SERVER_URL}/`);
    }
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await signUpThroughUi(page, { email: EMAIL, password: PASSWORD });
    await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), {
      timeout: 30_000,
    });
    // Signup hands off to the two-step onboarding wizard; the sidebar only
    // exists on the other side of it.
    await completeOnboardingIfRequired(page, {
      name: "Desktop Flows E2E",
      organisation: "Mike Desktop CI",
    });
    await page
      .getByRole("button", { name: "Assistant", exact: true })
      .first()
      .waitFor({ timeout: 20_000 });

    // Dismiss any first-run overlay (welcome / API-key modal).
    await dismissFirstRunOverlay(page);
    await shot(page, "flows-01-signed-in");
  });

  // ── a. OAuth popup mechanics ─────────────────────────────────────────────
  // Reproduces exactly what settings/connectors does: open a named about:blank
  // popup FIRST, steer it to a cross-origin URL, and rely on
  // window.opener.postMessage for the result.
  let popup = null;
  await step("oauth popup: about:blank window.open allowed in-shell", page, async () => {
    // Listener must exist BEFORE the popup posts anything.
    await page.evaluate(() => {
      window.__mikeE2e = { oauthResults: [], popup: null };
      window.addEventListener("message", (e) => {
        if (e && e.data && e.data.type === "mcp_oauth_result") {
          window.__mikeE2e.oauthResults.push({
            origin: e.origin,
            success: e.data.success,
          });
        }
      });
    });
    const before = new Set(livePages(context));
    const { proxyNonNull } = await page.evaluate(() => {
      const w = window.open(
        "about:blank",
        "mike_mcp_oauth",
        "popup,width=560,height=720",
      );
      window.__mikeE2e.popup = w;
      return { proxyNonNull: w !== null };
    });
    assert(
      proxyNonNull,
      "window.open('about:blank', 'mike_mcp_oauth') returned null — shell denied the OAuth popup",
    );
    popup = await waitForNewPage(context, before, 10_000);
    assert(popup, "no new in-shell window appeared for the OAuth popup");
  });

  let popupInfo = null;
  await step("oauth popup: survives cross-origin navigation", page, async () => {
    assert(popup, "no popup from previous step");
    // The consent hop, against the REAL callback route: a bogus state makes
    // the backend serve its failure page, which runs the exact same
    // opener-postMessage script as success — the whole contract (COOP opt-out
    // included) without needing a live OAuth provider.
    await page.evaluate(
      (url) => {
        window.__mikeE2e.popup.location.href = url;
      },
      `${API_URL}/user/mcp-connectors/oauth/callback?state=mike-e2e-bogus&code=mike-e2e-bogus`,
    );
    await popup.waitForURL((url) => url.href.startsWith(API_URL), {
      timeout: 10_000,
    });
    // The callback page closes itself after ~2.5s — grab the in-popup facts
    // right away, before it goes.
    popupInfo = await popup.evaluate(() => ({
      openerAlive: window.opener !== null,
      hasBridge: typeof window.mikeDesktop !== "undefined",
    }));
    await shot(popup, "flows-02-oauth-popup");
  });

  await step("oauth popup: live opener back-channel, no mikeDesktop bridge", page, async () => {
    assert(popupInfo, "no popup facts from previous step");
    assert(
      popupInfo.openerAlive,
      "window.opener is null in the popup — postMessage callback can never arrive",
    );
    assert(
      !popupInfo.hasBridge,
      "popup has window.mikeDesktop — privileged bridge leaked to child windows",
    );
    // The strongest proof the back-channel works: the callback page's own
    // mcp_oauth_result message actually arrived at the opener, from the API
    // origin (the same origin the connectors page verifies against).
    const results = await waitFor(
      async () => {
        const r = await page.evaluate(
          () => window.__mikeE2e && window.__mikeE2e.oauthResults,
        );
        return r && r.length > 0 ? r : null;
      },
      10_000,
    );
    assert(results, "opener never received the callback's mcp_oauth_result");
    assert(
      results[0].origin === new URL(API_URL).origin,
      `mcp_oauth_result came from ${results[0].origin}, expected ${new URL(API_URL).origin}`,
    );
    assert(
      results[0].success === false,
      "bogus state should produce success:false",
    );
    // And the callback page tidies up after itself.
    const closed = await waitFor(async () => popup.isClosed() || null, 6_000);
    assert(closed, "callback page never closed its own popup window");
  });

  // ── b. External link → system browser (captured), never in-shell ────────
  await step("external link: no in-shell window, URL captured", page, async () => {
    const before = new Set(livePages(context));
    await page.evaluate((url) => {
      window.open(url);
    }, EXTERNAL_URL);
    await sleep(2_000);
    const rogue = livePages(context).find((p) => !before.has(p));
    assert(
      !rogue,
      `external window.open spawned an in-shell window (${rogue && rogue.url()})`,
    );
    const captured = await waitFor(() => {
      try {
        // Exact line match, not substring: the capture file is one URL per
        // line, and matching the whole line is both a tighter assertion and
        // free of the "URL substring" pattern static analysis flags.
        // `.some((line) => line === url)` rather than `.includes(url)`: both
        // are exact whole-element comparisons here, but CodeQL's
        // incomplete-url-substring-sanitization heuristic matches the
        // `.includes(<url>)` call shape without checking whether the receiver
        // is a string or an array, so the array form reads as a substring
        // test to it. An explicit === says the same thing unambiguously.
        return readFileSync(CAPTURE_FILE, "utf8")
          .split("\n")
          .some((line) => line === EXTERNAL_URL);
      } catch {
        return false;
      }
    }, 5_000);
    assert(
      captured,
      `openExternal was never called for ${EXTERNAL_URL} (capture file ${CAPTURE_FILE})`,
    );
  });

  // ── c. file: navigation guard (drop hijack fix) ──────────────────────────
  // Honest scope: a renderer-initiated remote→local navigation is refused by
  // Chromium itself (webSecurity), so this is a regression guard, not a test
  // of the will-navigate file: fence. The fence's real target — a
  // browser-initiated navigation from an OS file drop outside the dropzone —
  // can't be dispatched reliably over CDP; it is covered by code review and
  // manual testing (see the PR).
  await step("renderer file: navigation of the main window does not land", page, async () => {
    const urlBefore = page.url();
    await page.evaluate(() => {
      try {
        window.location.href = "file:///etc/hosts";
      } catch {
        /* a synchronous block may throw — that's fine */
      }
    });
    await sleep(1_500);
    assert(
      page.url() === urlBefore,
      `main window navigated away: ${page.url()}`,
    );
  });

  // ── c2. Opener-tabnabbing guard (the initiator check in will-navigate) ────
  // A fenced popup holds window.opener; steering the opener to a foreign URL
  // that the probe WOULD classify as a download must be dropped — not
  // downloaded, not bounced to the browser — because its initiator isn't the
  // main window's own frame.
  await step("popup cannot drive its opener into a silent download", page, async () => {
    const logBefore = readDownloadLog().length;
    let captureBefore = "";
    try {
      captureBefore = readFileSync(CAPTURE_FILE, "utf8");
    } catch {
      /* none yet */
    }
    const urlBefore = page.url();
    const tabnabUrl = `${API_URL}/health`; // JSON → probe would call it a download
    const before = new Set(livePages(context));
    await page.evaluate(() => {
      window.__tabnab = window.open("about:blank", "tabnab", "popup,width=300,height=200");
    });
    const evil = await waitForNewPage(context, before, 10_000);
    assert(evil, "tabnab popup never opened");
    await evil.evaluate((url) => {
      window.opener.location = url;
    }, tabnabUrl);
    await sleep(3_000);
    assert(
      page.url() === urlBefore,
      `opener navigated away via popup: ${page.url()}`,
    );
    const loggedAfter = readDownloadLog()
      .slice(logBefore)
      .some((e) => e.url === tabnabUrl);
    assert(!loggedAfter, "opener-driven foreign navigation was downloaded");
    let captureAfter = "";
    try {
      captureAfter = readFileSync(CAPTURE_FILE, "utf8");
    } catch {
      /* none */
    }
    assert(
      captureAfter === captureBefore,
      "opener-driven navigation leaked to the browser instead of being dropped",
    );
    await evil.close().catch(() => {});
  });

  // ── d. iframe failure isolation (did-fail-load must check isMainFrame) ───
  await step("failing iframe does not trigger the connect screen", page, async () => {
    const urlBefore = page.url();
    await page.evaluate(() => {
      document.body.appendChild(
        Object.assign(document.createElement("iframe"), {
          src: "http://127.0.0.1:59999/nope",
        }),
      );
    });
    await sleep(3_000);
    const now = page.url();
    assert(
      !now.startsWith("file:"),
      `main window bounced to the connect/offline screen: ${now}`,
    );
    assert(
      now === urlBefore,
      `main window navigated after iframe failure: ${now}`,
    );
  });

  // Steps c/d poked at navigation — restore a known-good page before the
  // download flows.
  await page.goto(`${SERVER_URL}/`).catch(() => {});

  // ── e. Blob download: settings → export account JSON ─────────────────────
  await step("blob download is saved by the shell download handler", page, async () => {
    await page.goto(`${SERVER_URL}/settings/privacy-data`);
    // The page has three identical "Export" buttons; scope to the innermost
    // container that holds both the "Export account JSON" label and a button
    // (frontend/src/app/(pages)/settings/privacy-data/page.tsx).
    const row = page
      .locator("div")
      .filter({ has: page.getByText("Export account JSON", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Export", exact: true }) })
      .last();
    const before = readDownloadLog().length;
    await row
      .getByRole("button", { name: "Export", exact: true })
      .click({ timeout: 15_000 });
    const entry = await waitForDownloadLogged(before, 20_000);
    assert(entry, "shell will-download handler never logged a completed download");
    assert(
      entry.savePath.startsWith(DOWNLOAD_DIR),
      `download saved outside MIKE_DOWNLOAD_DIR: ${entry.savePath}`,
    );
    console.log(`  ↳ downloaded: ${path.basename(entry.savePath)}`);
    await shot(page, "flows-03-blob-export");
  });

  // ── f. Presigned-URL download (DocTable downloadDoc) ─────────────────────
  // Part 1: the real UI — upload to the library, then row menu → Download.
  await step("library upload + row-menu Download stays in-shell", page, async () => {
    await page.goto(`${SERVER_URL}/library`);
    // PageHeader action button carries aria-label "Add Files"
    // (frontend/src/app/components/shared/PageHeader.tsx:254); the library
    // passes no renderAddDocumentsModal, so the click opens the hidden file
    // input directly (DocTable.openAddDocuments).
    const addBtn = page.getByRole("button", { name: "Add Files" });
    await addBtn.waitFor({ timeout: 15_000 });
    const chooserPromise = page.waitForEvent("filechooser", {
      timeout: 10_000,
    });
    await addBtn.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: DOC_NAME,
      mimeType: "application/pdf",
      buffer: readFileSync(PDF_FIXTURE),
    });
    await page
      .getByText(DOC_BASE, { exact: false })
      .first()
      .waitFor({ timeout: 30_000 });

    // Row actions ("···") stay hidden while doc.status is pending/processing
    // (DocTable.tsx:1617); the table doesn't necessarily poll, so reload
    // while waiting for ingestion to settle.
    const rowFor = () =>
      page
        .locator("div")
        .filter({ hasText: DOC_BASE })
        .filter({ has: page.getByRole("button", { name: "···" }) })
        .last();
    let menuBtn = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const candidate = rowFor().getByRole("button", { name: "···" }).first();
      if (await candidate.isVisible().catch(() => false)) {
        menuBtn = candidate;
        break;
      }
      await sleep(6_000);
      await page.reload().catch(() => {});
      await page
        .getByText(DOC_BASE, { exact: false })
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
    }
    assert(menuBtn, "document never finished processing (row menu never appeared)");

    const before = readDownloadLog().length;
    await menuBtn.click();
    await page
      .getByRole("button", { name: "Download", exact: true })
      .first()
      .click({ timeout: 10_000 });
    const entry = await waitForDownloadLogged(before, 20_000);
    assert(entry, "shell will-download handler never logged a completed download");
    assert(
      entry.savePath.startsWith(DOWNLOAD_DIR),
      `download saved outside MIKE_DOWNLOAD_DIR: ${entry.savePath}`,
    );
    assert(
      page.url().startsWith(SERVER_URL),
      `main window navigated away during download: ${page.url()}`,
    );
    console.log(`  ↳ downloaded: ${path.basename(entry.savePath)}`);
    await shot(page, "flows-04-doc-download");
  });

  // Part 2: direct fallback for the exact fixed code path — reproduce
  // downloadDoc (DocTable.tsx:2085) verbatim: fetch a presigned URL from the
  // app's own API, then click a download-attributed anchor pointing at the
  // foreign storage origin. Chromium ignores a.download cross-origin and
  // navigates, so this exercises will-navigate → probe → downloadURL even if
  // the row-menu step above failed for UI reasons.
  await step("presigned-URL anchor click resolves to an in-shell download", page, async () => {
    if (!page.url().startsWith(SERVER_URL)) await page.goto(`${SERVER_URL}/`);
    const before = readDownloadLog().length;
    const result = await page.evaluate(
      async ({ api, docBase, pdfB64 }) => {
        // Auth exactly as mikeApi.getAuthHeader does, minus the supabase
        // client: the session (with access_token) lives in localStorage under
        // sb-<ref>-auth-token (supabase-js default storage).
        let token = null;
        for (const key of Object.keys(localStorage)) {
          if (!/^sb-.*-auth-token$/.test(key)) continue;
          try {
            const parsed = JSON.parse(localStorage.getItem(key));
            token =
              parsed?.access_token ?? parsed?.currentSession?.access_token;
            if (token) break;
          } catch {
            /* not a session blob */
          }
        }
        if (!token) return { error: "no supabase access token in localStorage" };
        const headers = { Authorization: `Bearer ${token}` };

        // Reuse the doc uploaded by the UI step; upload one ourselves if that
        // step didn't get that far.
        const listRes = await fetch(`${api}/single-documents`, { headers });
        if (!listRes.ok)
          return { error: `list documents: HTTP ${listRes.status}` };
        const docs = await listRes.json();
        let doc = docs.find((d) => (d.filename || "").includes(docBase));
        if (!doc) {
          const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
          const form = new FormData();
          form.append(
            "file",
            new File([bytes], `${docBase}-fallback.pdf`, {
              type: "application/pdf",
            }),
          );
          const upRes = await fetch(`${api}/single-documents`, {
            method: "POST",
            headers,
            body: form,
          });
          if (!upRes.ok) return { error: `upload: HTTP ${upRes.status}` };
          doc = await upRes.json();
        }

        // getDocumentUrl (mikeApi.ts:1164) → presigned storage URL on a
        // foreign origin.
        const urlRes = await fetch(`${api}/single-documents/${doc.id}/url`, {
          headers,
        });
        if (!urlRes.ok)
          return { error: `presigned url: HTTP ${urlRes.status}` };
        const { url, filename } = await urlRes.json();

        // downloadDoc, verbatim.
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        return { url, filename };
      },
      {
        api: API_URL,
        docBase: DOC_BASE,
        pdfB64: readFileSync(PDF_FIXTURE).toString("base64"),
      },
    );
    assert(!result.error, result.error);
    console.log(`  ↳ presigned URL: ${result.url}`);
    const entry = await waitForDownloadLogged(before, 20_000);
    assert(entry, "shell will-download handler never logged a completed download");
    assert(
      entry.url === result.url,
      `logged download URL differs from the presigned URL: ${entry.url}`,
    );
    // The probe must have chosen downloadURL, not the browser bounce.
    let captured = "";
    try {
      captured = readFileSync(CAPTURE_FILE, "utf8");
    } catch {
      /* nothing captured — good */
    }
    assert(
      !captured.includes(result.url),
      "presigned URL was bounced to the system browser instead of downloading",
    );
    assert(
      page.url().startsWith(SERVER_URL),
      `main window navigated away during download: ${page.url()}`,
    );
    console.log(`  ↳ downloaded: ${path.basename(entry.savePath)}`);
  });

  writeFileSync(
    path.join(ARTIFACTS, `flows-summary-${RUN_ID}.json`),
    JSON.stringify(
      {
        ok: failures.length === 0,
        EMAIL,
        SERVER_URL,
        API_URL,
        DOWNLOAD_DIR,
        CAPTURE_FILE,
        downloads: readDownloadLog(),
        failures,
      },
      null,
      2,
    ),
  );
} catch (err) {
  failures.push({ step: "(suite)", error: err.message });
  console.error(`FAIL: ${err.message}`);
  try {
    const b = browser ?? (await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`));
    const p = b.contexts()[0]?.pages()[0];
    if (p) await shot(p, "flows-99-failure");
  } catch {
    /* app already gone */
  }
} finally {
  try {
    await browser?.close();
  } catch {
    /* already closed */
  }
  app.kill();
}

if (failures.length > 0) {
  console.error(`FLOWS E2E FAILED (${failures.length} step(s)):`);
  for (const f of failures) console.error(`  ✗ ${f.step}: ${f.error}`);
  process.exitCode = 1;
} else {
  console.log("FLOWS E2E PASSED");
}
