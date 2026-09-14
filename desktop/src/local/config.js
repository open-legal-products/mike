// Shared constants for the self-contained local stack.
//
// Ports are FIXED, not discovered: the frontend bakes
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_API_BASE_URL into its JS bundle at
// build time, so the gateway and backend must always be where the bundle
// says they are. The 428xx range is IANA-unassigned and collision-unlikely;
// a conflict is detected at boot and surfaced, not worked around.

const path = require("path");

const PORTS = {
  postgres: 42810,
  gotrue: 42811,
  postgrest: 42812,
  gateway: 42813, // browser-facing: supabase-js hits /auth/v1 + /rest/v1 here
  backend: 42814,
  frontend: 42815,
};

const FRONTEND_URL = `http://localhost:${PORTS.frontend}`;
const GATEWAY_URL = `http://localhost:${PORTS.gateway}`;
const BACKEND_URL = `http://localhost:${PORTS.backend}`;

// The anon key baked into the frontend bundle. It is the WELL-KNOWN Supabase
// localhost demo anon JWT (public knowledge, role=anon) — deliberately NOT a
// key our stack accepts: GoTrue and PostgREST validate against the
// per-install secret minted on first run, so demo-signed tokens are
// worthless here. The local gateway swaps this exact placeholder value for
// the real per-install anon JWT on the way through (see gateway.js). That
// keeps per-install secrets out of the build while never teaching the
// services to trust a well-known key.
const PLACEHOLDER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Where the binaries and built app live. Dev mode runs straight out of the
// repo checkout; the packaged app carries the same layout in resources.
function stackPaths(app) {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "local-stack")
    : path.join(repoRoot, "desktop", "local-stack");
  return {
    bin: path.join(base, "bin"),
    pgBin: path.join(base, "bin", "pg", "bin"),
    gotrue: path.join(base, "bin", "gotrue"),
    gotrueMigrations: path.join(base, "bin", "gotrue-migrations"),
    postgrest: path.join(base, "bin", "postgrest"),
    backendDir: app.isPackaged
      ? path.join(base, "app", "backend")
      : path.join(repoRoot, "backend"),
    frontendStandalone: app.isPackaged
      ? path.join(base, "app", "frontend")
      : path.join(repoRoot, "frontend", ".next", "standalone"),
  };
}

// Per-install mutable state, quarantined under userData/local so wiping it
// resets the local product without touching shell settings.
function dataPaths(app) {
  const root = path.join(app.getPath("userData"), "local");
  return {
    root,
    pgdata: path.join(root, "pgdata"),
    storage: path.join(root, "storage"),
    logs: path.join(root, "logs"),
    secretsFile: path.join(root, "secrets.json"),
  };
}

module.exports = {
  PORTS,
  FRONTEND_URL,
  GATEWAY_URL,
  BACKEND_URL,
  PLACEHOLDER_ANON_KEY,
  stackPaths,
  dataPaths,
};
