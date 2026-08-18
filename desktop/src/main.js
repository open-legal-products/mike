// Mike for Mac — a native desktop shell around the Mike web app.
//
// Design decision (mirrors the Word add-in): Mike clients don't re-implement
// the product UI — the web app IS the product, and this shell gives it a
// first-class macOS home: real menu bar with shortcuts, window-state
// persistence, external links opening in the default browser, a connection
// screen when the server is unreachable, and a single-instance dock presence.
// Nothing in here knows about chats, documents or reviews; it only knows how
// to host them.

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  session,
  net,
  clipboard,
} = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// Out of the box the shell points at the hosted service, so a downloaded app
// works with no local stack. Self-hosters retarget via the connect screen
// (⌘⇧,), --server-url=, or MIKE_SERVER_URL — see serverUrl() below.
const DEFAULT_SERVER_URL = "https://app.mikeoss.com";
const CONNECT_PAGE = path.join(__dirname, "pages", "connect.html");
// Prefix for the shell's own bundled pages — the only file: URLs the main
// window is ever allowed to show.
const SHELL_PAGES_URL_PREFIX = pathToFileURL(
  path.join(__dirname, "pages"),
).href;
const PING_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Settings — a plain JSON file in userData. Deliberately no dependency: the
// shell stores two things (server URL, window bounds) and a schema-less file
// keeps the prototype inspectable (~/Library/Application Support/Mike/).
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[mike-desktop] failed to save settings", err);
  }
  return next;
}

// Precedence: --server-url= argv, then MIKE_SERVER_URL, then settings.json,
// then default. The two overrides exist so automation (e2e against a shifted
// compose stack) can retarget the packaged app without touching the user's
// real settings file.
const serverUrl = () => {
  const argv = process.argv.find((a) => a.startsWith("--server-url="));
  const override =
    argv?.slice("--server-url=".length) ?? process.env.MIKE_SERVER_URL;
  if (typeof override === "string" && override.trim()) {
    return override.trim().replace(/\/+$/, "");
  }
  const configured = loadSettings().serverUrl;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_SERVER_URL;
};

// ---------------------------------------------------------------------------
// External links — one funnel for every hand-off to the default browser.
// MIKE_E2E_CAPTURE_EXTERNAL (a file path) diverts the URL to that file
// instead, so e2e can assert "the shell WOULD have opened the browser here"
// without actually spraying tabs across the test machine.
// ---------------------------------------------------------------------------

function openExternalOrCapture(url) {
  const captureFile = process.env.MIKE_E2E_CAPTURE_EXTERNAL;
  if (captureFile) {
    try {
      fs.appendFileSync(captureFile, url + "\n");
    } catch (err) {
      console.error("[mike-desktop] failed to capture external url", err);
    }
    return;
  }
  void shell.openExternal(url);
}

// ---------------------------------------------------------------------------
// Navigation policy — who may show what, where.
//
// The main window hosts exactly one origin: the configured Mike server (plus
// the shell's own bundled pages). Popups exist for one reason: the MCP
// connector OAuth flow opens `about:blank` first to keep a synchronous window
// handle, then steers it through third-party consent pages and back to an
// API-origin callback that reports success via `window.opener.postMessage`.
// That whole chain must stay INSIDE the popup — bouncing any hop to the
// system browser severs `window.opener` and strands the flow.
// ---------------------------------------------------------------------------

const isHttp = (url) => /^https?:\/\//i.test(url);
// window.open("about:blank", ...) reaches the handler as "about:blank"; some
// Chromium paths hand over "" — both are the script-driven-popup case.
const isBlankUrl = (url) => !url || url === "about:blank";

const isAppOrigin = (url) => {
  try {
    return new URL(url).origin === new URL(serverUrl()).origin;
  } catch {
    return false;
  }
};

// Child windows must NOT inherit the shell preload: a third-party consent
// page could otherwise call mikeDesktop.setServerUrl and repoint the shell at
// a hostile origin. `preload: undefined` here does defeat Electron's default
// preload inheritance (verified live: the popup has no window.mikeDesktop
// while window.opener/postMessage back to the app keep working — stripping
// the preload does not touch the opener wiring, which lives in Chromium's
// window-proxy plumbing, not in any script we inject).
const POPUP_WINDOW_OPTIONS = {
  autoHideMenuBar: true,
  webPreferences: {
    preload: undefined,
    contextIsolation: true,
    nodeIntegration: false,
  },
};

// Shared window.open policy for the main window and every child: blank and
// app-origin targets become real (fenced, preload-less) windows; external
// http(s) goes to the default browser; anything else (file:, custom schemes)
// is dropped outright.
function windowOpenPolicy({ url }) {
  if (isBlankUrl(url) || isAppOrigin(url)) {
    return {
      action: "allow",
      overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS,
    };
  }
  // mailto: matters even though the frontend has none of its own — the
  // markdown renderer gives every LLM-authored link target=_blank, and a
  // model can perfectly well emit a mailto link in an answer.
  if (isHttp(url) || url.startsWith("mailto:")) {
    openExternalOrCapture(url);
  }
  return { action: "deny" };
}

// Fence applied to every allowed child window (and, recursively, to popups a
// popup opens). Deliberately NOT attached: the connect-screen did-fail-load
// bounce — a consent page failing to load must not hijack the main session.
function fenceChildWindow(child) {
  const contents = child.webContents;
  contents.on("will-navigate", (event, url) => {
    // OAuth consent chains hop across many origins (IdP → consent → API
    // callback); all http(s) hops must stay in the popup so window.opener
    // survives. Everything else — file: above all — is blocked, not bounced.
    if (isHttp(url) || isBlankUrl(url)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(windowOpenPolicy);
  contents.on("did-create-window", fenceChildWindow);
  attachContextMenu(contents);
}

// Navigation policy for the main window, shared by will-navigate and
// will-redirect. App-origin and the shell's own pages pass; everything else is
// prevented, then — only if the MAIN WINDOW ITSELF initiated it — resolved to
// a download or the browser.
//
// The initiator gate closes an opener-tabnabbing hole the popup design opens
// up: every fenced popup holds a live window.opener handle, and the HTML spec
// lets a cross-origin auxiliary context navigate its opener. Without this
// check, a hostile consent page could run `opener.location = evil.dmg`, whose
// foreign navigation the main window would silently probe and download with no
// prompt. A navigation whose initiator is anything but the main window's own
// main frame (a popup, a subframe, or unknown) is dropped outright.
function handleMainWindowNavigation(event, url) {
  if (isAppOrigin(url)) return;
  // The shell's own bundled pages are the ONLY file: URLs allowed — exempting
  // all of file: would let an OS file dropped outside the chat dropzone
  // navigate the whole app to the local file.
  if (url.startsWith(SHELL_PAGES_URL_PREFIX)) return;
  event.preventDefault();

  const selfInitiated =
    win &&
    !win.webContents.isDestroyed() &&
    event.initiator === win.webContents.mainFrame;
  if (!selfInitiated) return;

  if (isHttp(url)) {
    // Foreign-origin same-window navigation: probe whether it's really a
    // download (presigned doc URL) or a page for the browser — see the
    // Downloads section for why this can't be decided synchronously.
    void resolveForeignNavigation(url, win.webContents);
  } else if (url.startsWith("mailto:")) {
    // Same rationale as in windowOpenPolicy: model-authored markdown can emit
    // mailto links, and those belong to the OS mail client.
    openExternalOrCapture(url);
  }
  // Other schemes: swallowed. Nothing legitimate reaches here.
}

// ---------------------------------------------------------------------------
// Downloads
//
// Same-window navigations to foreign origins are, in this app, almost always
// presigned storage URLs (DocTable's `a.href = url; a.download; a.click()` —
// the `download` attribute is ignored cross-origin, so it reaches us as a
// plain navigation). Real external links all use target=_blank and never hit
// this path. will-navigate fires before any response headers exist, so we
// probe the URL for one byte and decide: attachment/binary → download in-app,
// looks like a page (or the probe fails) → default browser.
// ---------------------------------------------------------------------------

async function resolveForeignNavigation(url, webContents) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let shouldDownload = false;
  try {
    // GET with Range, not HEAD: presigned URLs are commonly signed for GET
    // only, and Range keeps the probe from pulling the whole file.
    const res = await net.fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    // Headers are all we need — drop the body before it buffers anything.
    try {
      await res.body?.cancel();
    } catch {
      /* body may already be closed */
    }
    const disposition = (
      res.headers.get("content-disposition") ?? ""
    ).toLowerCase();
    const type = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    shouldDownload =
      disposition.includes("attachment") ||
      (type !== "" && type !== "text/html" && type !== "application/xhtml+xml");
  } catch {
    // Unreachable/CORS-less/timeout — the browser can deal with it.
  } finally {
    clearTimeout(timer);
  }
  // Decided outside the try so a throw from downloadURL (e.g. the window was
  // closed during the probe) can't fall through to openExternalOrCapture and
  // surprise-open a presigned download URL in the system browser.
  if (shouldDownload) {
    if (!webContents.isDestroyed()) webContents.downloadURL(url);
    return;
  }
  openExternalOrCapture(url);
}

// " (2)", " (3)"… before the extension, like Finder does. reservedSavePaths
// covers the in-flight gap existsSync can't see: two downloads of the same
// name fired near-simultaneously would otherwise both resolve to one path and
// the second would clobber the first.
const reservedSavePaths = new Set();
function collisionFreeSavePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (
    let n = 2;
    fs.existsSync(candidate) || reservedSavePaths.has(candidate);
    n += 1
  ) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  reservedSavePaths.add(candidate);
  return candidate;
}

function setupDownloads() {
  session.defaultSession.on("will-download", (_event, item) => {
    // No save dialog on purpose: the flow starts from an in-app "download"
    // affordance, and a native prompt would be a worse experience than the
    // browser it replaces. MIKE_DOWNLOAD_DIR exists for e2e artifact capture.
    const dir = process.env.MIKE_DOWNLOAD_DIR || app.getPath("downloads");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* setSavePath will surface the failure via "interrupted" below */
    }
    const savePath = collisionFreeSavePath(dir, item.getFilename());
    item.setSavePath(savePath);
    item.once("done", (_e, state) => {
      // Seam twin of MIKE_E2E_CAPTURE_EXTERNAL: an attached automation client
      // (Playwright over CDP) installs its own browser-level download
      // behavior, diverting the bytes away from setSavePath — so e2e can't
      // watch the directory. This log records that the handler ran and where
      // it saved (or would have, under automation).
      const logFile = process.env.MIKE_E2E_DOWNLOAD_LOG;
      if (logFile) {
        try {
          fs.appendFileSync(
            logFile,
            JSON.stringify({ state, savePath, url: item.getURL() }) + "\n",
          );
        } catch (err) {
          console.error("[mike-desktop] failed to log download", err);
        }
      }
      reservedSavePaths.delete(savePath);
      if (state === "completed") {
        app.dock?.downloadFinished(savePath);
      } else {
        console.error("[mike-desktop] download", state, item.getURL());
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Context menu — right-click copy/paste/spellcheck, the absence of which is
// the fastest way for a web-in-a-window app to feel broken. Shared by the
// main window and every child.
// ---------------------------------------------------------------------------

function attachContextMenu(contents) {
  contents.on("context-menu", (_event, params) => {
    const template = [];

    for (const suggestion of params.dictionarySuggestions ?? []) {
      template.push({
        label: suggestion,
        click: () => contents.replaceMisspelling(suggestion),
      });
    }
    if (params.misspelledWord) {
      template.push({
        label: "Add to Dictionary",
        click: () =>
          contents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
      });
      template.push({ type: "separator" });
    }

    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy" });
    }

    // Only web/mail links get browser hand-off: openExternal launches a URL
    // with its default OS handler, so a file:/custom-scheme href (an LLM can
    // emit any href, and this menu is attached to fenced popups too) must not
    // be reachable here — that would re-open the exact scheme door the
    // navigation policy keeps shut. Copy Link stays available for any scheme.
    if (params.linkURL) {
      if (template.length > 0) template.push({ type: "separator" });
      if (isHttp(params.linkURL) || params.linkURL.startsWith("mailto:")) {
        template.push({
          label: "Open Link in Browser",
          click: () => openExternalOrCapture(params.linkURL),
        });
      }
      template.push({
        label: "Copy Link",
        click: () => clipboard.writeText(params.linkURL),
      });
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup();
    }
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let win = null;

function createWindow() {
  const { bounds } = loadSettings();
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    // The frontend flips to mobile chrome below 768px innerWidth — keep the
    // window from ever slipping into a phone layout on the desktop.
    minWidth: 800,
    minHeight: 600,
    show: false,
    // Content draws up to the top edge behind inset traffic lights — the
    // standard "modern mac app" look without touching the web app's CSS.
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    saveSettings({ bounds: win.getBounds() });
  });
  win.on("closed", () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(windowOpenPolicy);
  win.webContents.on("did-create-window", fenceChildWindow);
  attachContextMenu(win.webContents);

  // will-redirect shares the handler: a 30x off-origin does NOT fire
  // will-navigate, and letting it through would render a foreign page in the
  // main window — the one window that carries the preload bridge. Same policy
  // for both.
  win.webContents.on("will-navigate", handleMainWindowNavigation);
  win.webContents.on("will-redirect", handleMainWindowNavigation);

  // Server died mid-session (laptop closed, docker stopped): show the
  // connection screen instead of Chromium's error page. Subframes and
  // subresources fail all the time (ad-blocked iframes, dead embeds) and
  // must not kick a healthy session to the connect screen.
  win.webContents.on(
    "did-fail-load",
    (_e, code, _desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3 /* aborted, e.g. our own redirect */) return;
      if (failedUrl && failedUrl.startsWith("file:")) return;
      void showConnectPage();
    },
  );

  void connectOrExplain();
}

async function serverReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // fetch resolves for ANY http response (including 404/405) and only
    // throws on network failure — exactly the reachability signal we want.
    await fetch(url, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function connectOrExplain() {
  if (!win) return;
  if (await serverReachable(serverUrl())) {
    await win.loadURL(serverUrl());
  } else {
    await showConnectPage();
  }
}

async function showConnectPage() {
  if (!win) return;
  await win.loadFile(CONNECT_PAGE, {
    query: { server: serverUrl() },
  });
}

// ---------------------------------------------------------------------------
// IPC for the connection screen
// ---------------------------------------------------------------------------

// These channels change where the shell points and reload it — power the
// hosted web app must never wield. The preload bridge is attached to the main
// window too, so gate every handler on the sender actually being one of the
// shell's own bundled pages (the connect screen); a request from the loaded
// product (or an XSS within it) is ignored.
const fromShellPage = (event) =>
  (event.senderFrame?.url ?? "").startsWith(SHELL_PAGES_URL_PREFIX);

ipcMain.handle("mike:get-server-url", () => serverUrl());
ipcMain.handle("mike:set-server-url", (event, url) => {
  if (fromShellPage(event) && typeof url === "string" && url.trim()) {
    saveSettings({ serverUrl: url.trim().replace(/\/+$/, "") });
  }
  return serverUrl();
});
ipcMain.handle("mike:retry", (event) => {
  if (fromShellPage(event)) return connectOrExplain();
});

// ---------------------------------------------------------------------------
// Menu — the part a browser tab can never give the product. ⌘1–⌘5 mirror the
// sidebar's NAV_ITEMS order (AppSidebar.tsx), ⌘6 the History entry from its
// footer menu, so muscle memory transfers between the sidebar and the keys.
// ---------------------------------------------------------------------------

function navigate(pathname) {
  if (!win) return;
  const target = new URL(pathname, serverUrl()).toString();
  void win.loadURL(target);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          // mac convention: ⌘, is the app's settings, so it goes to the
          // product's settings page; the shell's own (rarer) server picker
          // moves to the shifted variant.
          label: "Settings…",
          accelerator: "Cmd+,",
          click: () => navigate("/settings"),
        },
        {
          label: "Change Server…",
          accelerator: "Cmd+Shift+,",
          click: () => void showConnectPage(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: "Cmd+N",
          click: () => navigate("/assistant"),
        },
        { type: "separator" },
        {
          label: "Assistant",
          accelerator: "Cmd+1",
          click: () => navigate("/assistant"),
        },
        {
          label: "Projects",
          accelerator: "Cmd+2",
          click: () => navigate("/projects"),
        },
        {
          label: "Library",
          accelerator: "Cmd+3",
          click: () => navigate("/library"),
        },
        {
          label: "Tabular Review",
          accelerator: "Cmd+4",
          click: () => navigate("/tabular-reviews"),
        },
        {
          label: "Workflows",
          accelerator: "Cmd+5",
          click: () => navigate("/workflows"),
        },
        {
          label: "History",
          accelerator: "Cmd+6",
          click: () => navigate("/history"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Home",
          accelerator: "Cmd+Shift+H",
          click: () => navigate("/"),
        },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Mike on GitHub",
          click: () =>
            openExternalOrCapture("https://github.com/Open-Legal-Products/mike"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Test seam: relocate userData BEFORE the single-instance lock and any window
// bounds are read/written. Without it an e2e run would fight the developer's
// own running Mike.app for the instance lock (and lose, quitting instantly)
// and would read/write their real window bounds. Must precede requestSingle-
// InstanceLock — the lock lives in userData.
if (process.env.MIKE_USER_DATA_DIR) {
  app.setPath("userData", process.env.MIKE_USER_DATA_DIR);
}

// One dock icon, one window; a second launch focuses the first instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    setupDownloads();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Mac convention: closing the window keeps the app in the dock.
  app.on("window-all-closed", () => {
    // no-op on purpose; Cmd+Q quits.
  });
}

process.on("uncaughtException", (err) => {
  console.error("[mike-desktop] uncaught", err);
  if (app.isReady() && win === null) {
    dialog.showErrorBox("Mike", String(err?.message ?? err));
  }
});
