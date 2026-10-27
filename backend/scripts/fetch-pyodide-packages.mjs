// Downloads the Python wheels the code-analysis sandbox loads, so the image
// and the dev machine never fetch at run time. Pyodide's own packages come
// from its CDN with the hashes in its lock file; openpyxl is not in that lock,
// so it comes from PyPI with the hashes pinned here. Idempotent: a wheel whose
// hash already matches is kept.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "vendor", "pyodide-packages");

const PACKAGES = ["numpy", "pandas", "openpyxl", "python-dateutil", "regex"];

const PYPI = [
  {
    name: "openpyxl",
    version: "3.1.5",
    file_name: "openpyxl-3.1.5-py2.py3-none-any.whl",
    sha256: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
    url: "https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
    depends: ["et_xmlfile"],
  },
  {
    name: "et_xmlfile",
    version: "2.0.0",
    file_name: "et_xmlfile-2.0.0-py3-none-any.whl",
    sha256: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
    url: "https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
    depends: [],
  },
];

const lock = require("pyodide/pyodide-lock.json");
const { version } = require("pyodide/package.json");
const base = process.env.PYODIDE_PACKAGE_BASE_URL ?? `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

const wanted = new Map();
const queue = [...PACKAGES];
while (queue.length) {
  const name = queue.pop();
  if (wanted.has(name)) continue;
  const fromPypi = PYPI.find((p) => p.name === name);
  const entry = fromPypi
    ? { ...fromPypi, source: fromPypi.url }
    : lock.packages[name]
      ? { ...lock.packages[name], source: base + lock.packages[name].file_name }
      : null;
  if (!entry) throw new Error(`${name} is neither in pyodide ${version}'s lock nor pinned from PyPI`);
  wanted.set(name, entry);
  queue.push(...entry.depends);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(out, { recursive: true });
const manifest = {};
for (const [name, entry] of wanted) {
  const target = path.join(out, entry.file_name);
  let bytes = await readFile(target).catch(() => null);
  if (!bytes || sha256(bytes) !== entry.sha256) {
    const response = await fetch(entry.source);
    if (!response.ok) throw new Error(`${entry.source}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file_name}: hash mismatch`);
    await writeFile(target, bytes);
    console.log(`fetched ${entry.file_name}`);
  }
  manifest[name] = { version: entry.version, file_name: entry.file_name, sha256: entry.sha256, depends: entry.depends };
}
await writeFile(path.join(out, "manifest.json"), JSON.stringify({ pyodide: version, packages: manifest }, null, 2) + "\n");
console.log(`${wanted.size} packages in ${out}`);
