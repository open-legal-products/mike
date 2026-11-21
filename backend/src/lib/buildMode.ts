/**
 * What counts as a development build of the backend, in one place.
 *
 * A development build is a contributor's checkout running the TypeScript
 * source (`tsx watch src/index.ts`, `npm run dev`, `node --import tsx`,
 * ts-node, Bun, Node's type stripping). Every install runs compiled
 * JavaScript: the image's `npm start`, `node dist/index.js`,
 * `node dist/jobs/...`, and the desktop app's staged `dist/index.js`.
 *
 * NODE_ENV cannot tell the two apart. docker compose runs the compiled
 * image with `NODE_ENV=${NODE_ENV:-development}`, backend/.env.example
 * ships `NODE_ENV=development` (loaded by dotenv for `npm start`), and the
 * desktop supervisor passes `NODE_ENV=development` too. Anything that
 * behaves differently for a development build (Sentry's default
 * destination and `build_mode` tag, which boot failures are reported) must
 * use this check, not NODE_ENV, or every one of those installs is treated
 * as a laptop.
 *
 * Worker threads share the parent's argv, so they agree with it.
 *
 * This file is byte-identical in the branches of #782 and #791 so whichever
 * merges second resolves without a conflict.
 */
export function isDevelopmentBuild(argv: readonly string[] = process.argv): boolean {
  return /\.[cm]?tsx?$/.test(argv[1] ?? "");
}
