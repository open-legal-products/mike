# Feature flags and the admin panel

A feature flag answers one question per user: is this feature on for them?
Instance admins change the answer from **Settings → Admin** without a
redeploy, for the whole deployment or for one account.

## Who is an admin

`MIKE_ADMIN_EMAILS` in the backend environment is a comma-separated list of
email addresses. An account whose **confirmed** address is on the list sees
the **Admin** area in Settings and may call the `/admin` API; everyone else
gets `403 instance_admin_required`. There is no way to become an admin from
inside the app, so a compromised account cannot promote itself. Changes step
up to MFA when the admin has it enrolled, like other sensitive settings, and
are recorded in the audit log (`feature_flag.default_updated`,
`feature_flag.user_updated`).

```text
MIKE_ADMIN_EMAILS=will@example.com,amal@example.com
```

## How a flag is resolved

Three layers, the most specific one winning:

1. **User override**: set by an admin for one account (`user_feature_flags`).
2. **Deployment default**: set by an admin for everyone (`feature_flag_defaults`).
3. **Code default**: what the flag's definition says, which may read server
   configuration.

A user with no row in either table gets the code default, so a database
upgraded by `backend/migrations/20261027_01_feature_flags.sql` behaves exactly
as before until an admin changes something. The registry of flags lives in
`backend/src/lib/featureFlags.ts`; a key that is not in it cannot be stored.
Both tables are service-role only: a browser session never reads or writes
them.

## The Google flags

Google verifies OAuth scopes one bundle at a time, and its reviewers insist
that the consent screen, the Cloud Console and the running code request the
same scopes. Each scope bundle is therefore its own flag:

| Flag | Scopes it allows Mike to request | Needs |
| --- | --- | --- |
| `google-drive` | `drive.file` (reads and writes of files added through the Picker or created by Mike) | |
| `gmail-read` | `gmail.readonly` | |
| `gmail-write` | `gmail.compose` | `gmail-read` |
| `google-calendar-read` | `calendar.calendarlist.readonly`, `calendar.events.readonly` | |
| `google-calendar-write` | `calendar.events` | `google-calendar-read` |

The code default of every Google flag honours
`GOOGLE_WORKSPACE_DISABLED_PROVIDERS` (see [Google Workspace](google-workspace.md)):
a service listed there has both its flags off unless an admin says otherwise.

What each flag changes for a user:

- **Read flag off**: Discover does not offer the service, `oauth/start`
  answers `404 connector_unavailable`, the assistant gets none of its tools,
  and an existing connection stays under Installed only so it can be deleted.
- **Write flag off**: the consent URL requests only the read bundle, so the
  consent screen never shows the write scope; no write tool is listed in the
  Manage dialog or offered to the assistant, and a direct call is refused,
  even over a grant that still carries the write scope.
- **Both on**: the behaviour documented in the Google Workspace guide.

This is how a hosted deployment runs Google's verification: keep a bundle off
for everyone until Google approves it, and turn it on for the reviewer's
account (and your own) while the demo video is recorded, so no unverified
scope reaches other users.

## Settings → Admin

The page has two sections built from the ordinary settings rows:

- **Feature flags**: one row per flag with a switch for its deployment
  default. The row says where the current default comes from, "server
  configuration" or "set here", and offers **Use server configuration** to
  clear a default that was set in the panel.
- **User overrides**: look an account up by the email address it signed up
  with, then choose **Default**, **On** or **Off** for each flag. The default
  option names the value it currently follows.

## API

All routes need a signed-in instance admin.

| Route | Purpose |
| --- | --- |
| `GET /admin/feature-flags` | Every flag with its code default and deployment default |
| `PUT /admin/feature-flags/:key` `{ enabled: true \| false \| null }` | Set or clear (null) the deployment default |
| `GET /admin/users/feature-flags?email=` | One user's overrides and effective values |
| `PUT /admin/users/:userId/feature-flags/:key` `{ enabled: true \| false \| null }` | Set or clear (null) that user's override |

## Adding a flag

Add an entry to `FEATURE_FLAGS` in `backend/src/lib/featureFlags.ts` (label,
description, group, code default) and to `FeatureFlagKey` in
`packages/contracts/index.d.ts`, then read it where the feature is decided
with `resolveFeatureFlags(db, userId)` or `isFeatureEnabled`. The admin panel
lists it automatically. Keep the decision in one place per feature, as
`backend/src/lib/integrations/googleAccess.ts` does for Google.
