// The release string every Mike runtime tags its Sentry events with, and the
// one the build plugins upload source maps under. Kept as plain CommonJS so
// next.config.ts and word-addin/webpack.config.js can require it at build
// time; `releaseName` in ./sentryEvent.ts is the TypeScript twin for runtime
// code, and sentryEvent.test.ts checks the two agree.
//
//   mike@<version>+<sha12>   CI build: VERSION (or VERSION-dev.<run>) + commit
//   mike@0.0.0+<sha12>       local image build without MIKE_VERSION
//   mike@0.0.0               dev checkout: no version, no commit
//
// Sentry parses `package@version+build` as semver, so releases order by
// version (an old self-hosted install reporting late sorts where it belongs)
// while the build metadata keeps the exact commit. 0.0.0 marks a build that
// did not come from the release workflow.

const UNVERSIONED = "0.0.0";
// Semver core, optional prerelease, no build metadata (the sha is the build).
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function normalizeVersion(raw) {
  const trimmed = (raw ?? "").trim().replace(/^v/, "");
  return VERSION_PATTERN.test(trimmed) ? trimmed : UNVERSIONED;
}

function releaseName(explicit, version, gitSha) {
  const named = (explicit ?? "").trim();
  if (named) return named;
  const sha = (gitSha ?? "").trim().slice(0, 12);
  const base = `mike@${normalizeVersion(version)}`;
  return sha ? `${base}+${sha}` : base;
}

module.exports = { UNVERSIONED, normalizeVersion, releaseName };
