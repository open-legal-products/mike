// Print the object-storage bucket CORS policy for this deployment on stdout.
//
// Browsers PUT uploads straight to the signed storage URL, so the bucket must
// allow every origin the backend trusts, or a client whose API calls succeed
// still has its uploads refused. The origins are NOT parsed here: they come
// from the backend's own configuredAllowedOrigins (backend/src/lib/origins.ts),
// fed the same variables the backend gets:
//
//   FRONTEND_URL     the web app (default http://localhost:3000)
//   WORD_ADDIN_URL   the Word add-in (default https://localhost:3200)
//   ALLOWED_ORIGINS  extra trusted client origins, comma-separated
//   NODE_ENV         production drops the localhost development defaults
//
// FRONTEND_URL and WORD_ADDIN_URL are reduced to their scheme://host[:port]
// and must be absolute http(s) URLs. An ALLOWED_ORIGINS entry is used only if
// it is already an exact origin, because the backend's CORS check compares
// the request's Origin header to it byte for byte: an entry with a path or
// upper-case host never matches there either, so it is skipped with a warning
// rather than silently widened.
//
// The origins module defaults to the backend source next to this file (Node
// 22.18+ strips the TypeScript types; 22.6+ with --experimental-strip-types).
// docker-compose.yml runs this inside the backend image with
// MIKE_ORIGINS_MODULE=/app/dist/lib/origins.js, so the policy always comes
// from the same release as the backend that serves it.
//
// This script must never stop the stack: compose starts createbucket, and
// then the backend, only after it exits 0. So every problem it can meet (an
// image built before origins.ts existed, a FRONTEND_URL without a scheme, a
// host WHATWG URL accepts but no browser sends, such as `mike_app`) is one
// clear "storage-cors:" line on stderr and a fallback that still allows the
// loopback development origins. Uploads from the misconfigured origin are
// then refused by CORS, as before this script existed, and the backend's
// boot warning and `docker compose logs storage-cors` say why.
//
//   FRONTEND_URL=https://mike.example node docker/storage-cors.mjs > cors.json
import { pathToFileURL } from "node:url";

const LOOPBACK_ORIGINS = ["http://localhost:3000", "https://localhost:3200"];

function warn(message) {
  process.stderr.write(`storage-cors: ${message}\n`);
}

async function loadConfiguredAllowedOrigins() {
  const modulePath = process.env.MIKE_ORIGINS_MODULE;
  try {
    const originsModule = await import(
      modulePath
        ? pathToFileURL(modulePath).href
        : new URL("../backend/src/lib/origins.ts", import.meta.url).href
    );
    // tsc's CommonJS output (the image's dist/) may surface under `default`.
    const fn =
      originsModule.configuredAllowedOrigins ??
      originsModule.default?.configuredAllowedOrigins;
    if (typeof fn === "function") return fn;
    warn(`${modulePath ?? "origins.ts"} has no configuredAllowedOrigins`);
  } catch (error) {
    warn(`cannot load the backend's origins module ${modulePath ?? "origins.ts"} (${error?.code ?? error?.message ?? error})`);
  }
  return null;
}

// An absolute http(s) URL whose host is a DNS name, IPv4 or [IPv6] literal.
// WHATWG URL accepts characters such as `"` in a host, which no browser
// would ever send as an Origin, so those are refused too.
function httpUrl(value) {
  try {
    const url = new URL(value);
    const webScheme = url.protocol === "http:" || url.protocol === "https:";
    const plainHost = /^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname);
    return webScheme && plainHost ? url : null;
  } catch {
    return null;
  }
}

function policyOrigins(configuredAllowedOrigins) {
  if (!configuredAllowedOrigins) {
    warn("falling back to the loopback development origins; uploads from any other origin will be refused by CORS");
    return LOOPBACK_ORIGINS;
  }
  const env = process.env;
  // Everything the backend trusts, and the same set without ALLOWED_ORIGINS:
  // the difference is exactly the extra entries, parsed the backend's way.
  const trusted = [...configuredAllowedOrigins(env)];
  const base = new Set(configuredAllowedOrigins({ ...env, ALLOWED_ORIGINS: "" }));

  const origins = [];
  let fallback = false;
  for (const entry of trusted) {
    const url = httpUrl(entry);
    if (base.has(entry)) {
      // FRONTEND_URL, WORD_ADDIN_URL, or a development default.
      if (url) {
        origins.push(url.origin);
      } else {
        warn(
          `skipping ${JSON.stringify(entry)}: FRONTEND_URL and WORD_ADDIN_URL must be absolute http(s) URLs ` +
            "whose host is a DNS name or IP literal (no underscores); uploads from it will be refused by CORS",
        );
        fallback = true;
      }
    } else if (url && url.origin === entry) {
      origins.push(entry);
    } else {
      warn(`skipping ALLOWED_ORIGINS entry that is not an exact http(s) origin: ${entry}`);
    }
  }
  if (origins.length === 0) {
    warn("no usable trusted origins; set FRONTEND_URL");
    fallback = true;
  }
  if (fallback) {
    warn("adding the loopback development origins so the stack still starts");
    origins.push(...LOOPBACK_ORIGINS);
  }
  return [...new Set(origins)];
}

let allowedOrigins;
try {
  allowedOrigins = policyOrigins(await loadConfiguredAllowedOrigins());
} catch (error) {
  warn(`unexpected failure (${error?.message ?? error}); falling back to the loopback development origins`);
  allowedOrigins = LOOPBACK_ORIGINS;
}

process.stdout.write(
  `${JSON.stringify(
    {
      CORSRules: [
        {
          AllowedOrigins: allowedOrigins,
          AllowedMethods: ["PUT", "HEAD"],
          AllowedHeaders: ["Content-Type", "x-amz-*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
    null,
    2,
  )}\n`,
);
