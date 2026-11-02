const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadOrCreateSecrets } = require("./secrets");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-secrets-"));
  return path.join(dir, "local", "secrets.json");
}

test("mints and persists secrets only when the file does not exist", () => {
  const file = tempFile();
  const first = loadOrCreateSecrets(file);
  assert.equal(first.version, 1);
  assert.ok(first.dbPassword && first.jwtSecret && first.guestPassword);
  assert.deepEqual(loadOrCreateSecrets(file), first);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["secrets.json"]);
});

// pgdata was initialised with the stored dbPassword: minting fresh secrets
// over a damaged file would lock the user out of their own workspace.
test("refuses to replace a secrets file it cannot parse", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  assert.throws(() => loadOrCreateSecrets(file), /not valid JSON/);
  fs.writeFileSync(file, JSON.stringify({ version: 2 }));
  assert.throws(() => loadOrCreateSecrets(file), /is invalid/);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ version: 2 }));
});

test("tops up guest credentials without touching the existing secrets", () => {
  const file = tempFile();
  const minted = loadOrCreateSecrets(file);
  const { guestEmail, guestPassword, ...legacy } = minted;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const loaded = loadOrCreateSecrets(file);
  assert.equal(loaded.dbPassword, minted.dbPassword);
  assert.equal(loaded.jwtSecret, minted.jwtSecret);
  assert.ok(loaded.guestEmail && loaded.guestPassword);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), loaded);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["secrets.json"]);
});
