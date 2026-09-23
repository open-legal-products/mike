// Shared constants for the self-contained local stack.
//
// Fixed ports keep local service wiring stable across launches. The supervisor
// supplies these URLs at runtime; the frontend uses its same-origin /api
// gateway and carries no Supabase keys. Port conflicts fail startup.

const path = require("path");

const PORTS = {
  postgres: 42810,
  gotrue: 42811,
  postgrest: 42812,
  gateway: 42813, // backend-only Supabase auth/data gateway
  backend: 42814,
  frontend: 42815,
};

const FRONTEND_URL = `http://localhost:${PORTS.frontend}`;
const GATEWAY_URL = `http://localhost:${PORTS.gateway}`;
const BACKEND_URL = `http://localhost:${PORTS.backend}`;

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
  stackPaths,
  dataPaths,
};
