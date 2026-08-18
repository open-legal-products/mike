// Per-install secrets for the local stack, minted once on first run.
//
// The compose stack ships the well-known Supabase demo JWT secret — fine for
// a developer's laptop, unacceptable baked into a downloadable app: anyone
// could mint a service_role token for every install in the world. Here every
// install generates its own secret set, so a token from one machine is
// gibberish on another, and no secret ever exists in the shipped bundle.
//
// Stored as a plain JSON file inside userData/local (same trust boundary as
// pgdata itself, which sits beside it — an attacker who can read one can
// read both).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Minimal HS256 JWT — enough for GoTrue and PostgREST role tokens; pulling in
// a JWT dependency for two static tokens would be overkill.
function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64url(sig)}`;
}

function mintSecrets() {
  const jwtSecret = crypto.randomBytes(48).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  // 10 years: these are role keys (like Supabase's anon/service keys), not
  // session tokens — sessions come from GoTrue with a normal short expiry.
  const exp = now + 10 * 365 * 24 * 3600;
  const claims = (role) => ({ iss: "mike-local", role, iat: now, exp });
  return {
    version: 1,
    jwtSecret,
    anonKey: signJwt(claims("anon"), jwtSecret),
    serviceRoleKey: signJwt(claims("service_role"), jwtSecret),
    dbPassword: crypto.randomBytes(24).toString("hex"),
    downloadSigningSecret: crypto.randomBytes(32).toString("hex"),
    userApiKeysEncryptionSecret: crypto.randomBytes(32).toString("hex"),
  };
}

function loadOrCreateSecrets(secretsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
    if (parsed?.version === 1 && parsed.jwtSecret) return parsed;
  } catch {
    // fall through to mint
  }
  const secrets = mintSecrets();
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), {
    mode: 0o600,
  });
  return secrets;
}

module.exports = { loadOrCreateSecrets };
