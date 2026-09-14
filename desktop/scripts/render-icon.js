// Renders assets/icon.html → assets/icon-1024.png with a transparent
// background, using Electron's own Chromium so the SVG filters/gradients come
// out exactly as the product renders them. Run via:
//   npx electron scripts/render-icon.js
// then build the .icns with scripts/make-icns.sh.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadFile(path.join(__dirname, "..", "assets", "icon.html"));
  // Give filters a beat to rasterize before capture.
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.webContents.capturePage({
    x: 0,
    y: 0,
    width: 1024,
    height: 1024,
  });
  const out = path.join(__dirname, "..", "assets", "icon-1024.png");
  fs.writeFileSync(out, image.toPNG());
  console.log("wrote", out, image.getSize());
  app.quit();
});
