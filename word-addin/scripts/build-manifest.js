const fs = require("fs");
const path = require("path");

const publicUrlInput = (process.env.WORD_ADDIN_PUBLIC_URL || "").trim();
let parsedPublicUrl;
try {
  parsedPublicUrl = new URL(publicUrlInput);
} catch {
  throw new Error(
    "WORD_ADDIN_PUBLIC_URL must be the deployed HTTPS origin for the Word add-in"
  );
}
if (
  parsedPublicUrl.protocol !== "https:" ||
  parsedPublicUrl.username ||
  parsedPublicUrl.password ||
  parsedPublicUrl.search ||
  parsedPublicUrl.hash ||
  parsedPublicUrl.pathname !== "/"
) {
  throw new Error(
    "WORD_ADDIN_PUBLIC_URL must be an HTTPS origin without credentials, a path, query, or fragment"
  );
}
const publicUrl = parsedPublicUrl.origin;

const distPath = path.resolve(__dirname, "../dist");
// Word and Outlook share the task pane; each host gets its own manifest.
for (const name of ["manifest.xml", "manifest.outlook.xml"]) {
  const manifest = fs
    .readFileSync(path.resolve(__dirname, "..", name), "utf8")
    .replaceAll("https://localhost:3200", publicUrl);
  if (manifest.includes("https://localhost:3200")) {
    throw new Error(`Production ${name} still contains localhost URLs`);
  }
  fs.writeFileSync(path.join(distPath, name), manifest);
}

const assetOutputPath = path.join(distPath, "assets");
fs.mkdirSync(assetOutputPath, { recursive: true });
for (const filename of ["icon-16.png", "icon-32.png", "icon-80.png"]) {
  fs.copyFileSync(
    path.resolve(__dirname, "../assets", filename),
    path.join(assetOutputPath, filename)
  );
}

console.log(`Wrote production Word and Outlook manifests and ribbon icons for ${publicUrl}`);
