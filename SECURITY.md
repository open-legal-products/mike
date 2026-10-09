# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| tip of `main` | ✅ |
| tagged releases (`v0.1.0`–`v0.4.0`) | ❌ |

Security fixes land only on `main`; the existing tags are historical
snapshots and do not receive backported fixes. If you are self-hosting,
please update to the latest `main` before reporting — the issue may already
be fixed.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:

**Security tab → Report a vulnerability** on this repository
(GitHub's private vulnerability reporting).

Please do not open a public issue for anything security-sensitive.

This project has a solo maintainer. You can expect an acknowledgment within
7 days; fixes are prioritized by severity after that.

## Scope

- Reports about the code, default configuration, and deployment guidance in
  this repo are all in scope.
- The **hosted service at `app.mikeoss.com`** (the cloud version offered from
  the official Mike website) is in scope — report issues affecting it through
  the same private channel above, and please keep testing non-destructive:
  only accounts and data you own, no denial of service, no access to other
  users' data beyond the minimum proof needed.
- **Independent self-hosted installations** run by third parties are the one
  exclusion: findings that only apply to how a specific outside operator has
  deployed Mike (their infrastructure, their configuration) should go to
  whoever operates that deployment.
- Mike is an **LLM legal product**, so LLM-specific reports are explicitly
  welcome: prompt injection (including via uploaded documents), getting the
  model to ignore its guardrails, leaking another user's data or system
  prompts through model output, and similar.
- Secrets accidentally committed to this repository's history are also worth
  a private report, even though CI runs a secret scanner.

## Dependency updates

Dependabot opens update suggestions as pull requests. The group name appears
in each PR title and gives the review order:

1. **priority-1-security-fixes:** advisory-driven fixes in every npm workspace
   and GitHub Actions. Review critical/high severity and production exposure
   first; do not wait for unrelated feature PRs.
2. **priority-2-production:** grouped weekly updates to application dependencies.
3. **priority-3-development / priority-3-actions:** grouped weekly updates to
   test, build and workflow tooling.

This is a review priority, not an automatic approval or merge. Each PR still
runs CI. The security audit reports all four workspaces even when one fails;
its high/critical gate is not weakened by these groups.

A repository admin must enable **Dependabot alerts** and **Dependabot security
updates** under Settings → Advanced Security. A committed `dependabot.yml`
alone enables version-update scheduling, not advisory-driven security fixes.
Security fixes do not wait for the weekly version-update schedule. The
configuration takes effect once merged into the default branch.

Verify setup in the repository's Security → Dependabot view and updater logs.
An admin can also check `GET /repos/open-legal-products/mike/vulnerability-alerts`
and `GET /repos/open-legal-products/mike/automated-security-fixes` (HTTP 204 means
that setting is enabled). A 404 from a non-admin credential is inconclusive;
check the settings as an admin. If the updater cannot produce a fix, inspect
its error and open a focused manual dependency PR. Do not suppress a newly
fixable advisory to make unrelated PRs green.

For runtime packages held by an npm override, update the override's minimum
and the matching lockfile together. For example, the sharp/librsvg advisory
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
requires sharp 0.35.5 or later. Validate native image decoding as well as the
audit; a version-only assertion does not establish that the binary loads.
