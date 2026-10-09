# Google connectors in Discover

Drive, Gmail, and Calendar now appear alongside the other services in Discover.
The separate Google accounts section has been removed. For a configured service,
**Add opens Google OAuth directly**, with read access by default. Users choose
the account on Google's screen; Mike has no preliminary account-selection dialog.
The OAuth request explicitly asks Google to show account selection and consent.
Google sign-in alone still does not connect any service.

While authorization is pending, the card shows Waiting for Google and Cancel.
Once connected, Manage provides disconnect, account replacement, and optional
Gmail/Calendar write upgrades. Missing server configuration still opens setup
help. Exact write approval remains inside the Assistant conversation.

## Verification

- Full frontend suite: **1,669 tests passed across 213 files**.
- Focused connector component suite: **34 passed**.
- Browser suite: **13 passed** — direct OAuth/cancellation for all three services,
  Gmail grant/write-upgrade/action/disconnect fixtures, and ten responsive/theme
  cases with normal and deliberately long emails.
- Normal email text fits a single line at 390/768/1280px; long text wraps without
  horizontal or vertical clipping. All three product logos load.
- Changed-file ESLint and production Webpack build/TypeScript passed.

Commands: `npm test --prefix frontend -- --maxWorkers=1`, focused Vitest files
for the connectors page and GoogleWorkspacePanel, and Playwright specs
`google-drive.spec.ts`, `google-workspace.spec.ts`, `google-layout.spec.ts`
against the production server. CI results for the pushed head are recorded in
[PR #434](https://github.com/open-legal-products/mike/pull/434).

## Evidence boundaries

These are actual browser screenshots of the rebuilt Mike application using
**synthetic API fixtures**, including `alex.morgan@example.com`. The provider
popup destination is intercepted for deterministic testing; no Google chooser
or consent screen is imitated in this gallery. OAuth-start screenshots show
Mike's pending state after Add and the absence of a preliminary Mike dialog.
No email was sent, no event changed, and no real Google grant was made by these
tests. Earlier live proofs and outstanding live acceptance remain in the
[combined testing report](google-integrations-2026-09-23.md).

## 1. Discover: optional connections

![Discover: optional connections](google-discover-2026-09-24/01-discover-add.png)

## 2. Drive: Add starts OAuth directly

![Drive: Add starts OAuth directly](google-discover-2026-09-24/02-drive-oauth-started.png)

## 3. Gmail: Add starts OAuth directly

![Gmail: Add starts OAuth directly](google-discover-2026-09-24/03-gmail-oauth-started.png)

## 4. Calendar: Add starts OAuth directly

![Calendar: Add starts OAuth directly](google-discover-2026-09-24/04-calendar-oauth-started.png)

## 5. Connected services in Discover

![Connected services in Discover](google-discover-2026-09-24/05-discover-connected.png)

## 6. Drive management after connection

![Drive management after connection](google-discover-2026-09-24/06-drive-manage.png)

## 7. Gmail management after connection

![Gmail management after connection](google-discover-2026-09-24/07-gmail-manage.png)

## 8. Calendar management after connection

![Calendar management after connection](google-discover-2026-09-24/08-calendar-manage.png)

## 9. Mobile, 390px

![Mobile, 390px](google-discover-2026-09-24/09-mobile.png)

## 10. Tablet, 768px

![Tablet, 768px](google-discover-2026-09-24/10-tablet.png)

## 11. Dark desktop

![Dark desktop](google-discover-2026-09-24/11-dark.png)

