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
} = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_SERVER_URL = "http://localhost:3000";
const CONNECT_PAGE = path.join(__dirname, "pages", "connect.html");
const PING_TIMEOUT_MS = 3_000;

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

const serverUrl = () => {
  const configured = loadSettings().serverUrl;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_SERVER_URL;
};

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
    minWidth: 720,
    minHeight: 480,
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

  // The window hosts exactly one origin: the configured Mike server. Anything
  // else — marketing links, cited sources, OAuth consent pages that must not
  // run inside an app shell — belongs in the user's real browser.
  const isAppOrigin = (url) => {
    try {
      return new URL(url).origin === new URL(serverUrl()).origin;
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppOrigin(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url) && !url.startsWith("file:")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Server died mid-session (laptop closed, docker stopped): show the
  // connection screen instead of Chromium's error page.
  win.webContents.on("did-fail-load", (_e, code, _desc, failedUrl) => {
    if (code === -3 /* aborted, e.g. our own redirect */) return;
    if (failedUrl && failedUrl.startsWith("file:")) return;
    void showConnectPage();
  });

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

ipcMain.handle("mike:get-server-url", () => serverUrl());
ipcMain.handle("mike:set-server-url", (_e, url) => {
  if (typeof url === "string" && url.trim()) {
    saveSettings({ serverUrl: url.trim().replace(/\/+$/, "") });
  }
  return serverUrl();
});
ipcMain.handle("mike:retry", () => connectOrExplain());

// ---------------------------------------------------------------------------
// Menu — the part a browser tab can never give the product.
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
          label: "Change Server…",
          accelerator: "Cmd+,",
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
        {
          label: "Projects",
          accelerator: "Cmd+P",
          click: () => navigate("/projects"),
        },
        {
          label: "Library",
          accelerator: "Cmd+L",
          click: () => navigate("/library"),
        },
        {
          label: "Workflows",
          accelerator: "Cmd+K",
          click: () => navigate("/workflows"),
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
            void shell.openExternal(
              "https://github.com/Open-Legal-Products/mike",
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

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
