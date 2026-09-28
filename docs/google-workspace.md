# Gmail and Google Calendar

Drive, Gmail, and Calendar are delivered together in [PR #434](https://github.com/open-legal-products/mike/pull/434). The Gmail/Calendar design is recorded in [#521](https://github.com/open-legal-products/mike/issues/521).

## User behavior

**Connecting is always opt-in, including for users who sign into Mike with Google.** Mike sign-in tokens are never reused for Gmail or Calendar. In Settings → Connectors → **Discover**, choose **Add** on Gmail or Google Calendar. This opens Google OAuth directly with read-only access; there is no Mike account-selection dialog. Use **Manage** on a connected card to change accounts, enable writes, or disconnect. Google shows an account chooser: choose a personal Gmail or Workspace account, including one different from your Mike login and different accounts for Gmail and Calendar. Each Mike user has one connection per service; choosing another account replaces that service's connection and invalidates its pending actions.

Workspace administrators and Google Cloud audience settings can restrict which accounts may authorize the app. Configure an External audience to support accounts outside the Cloud project's organization. Testing mode also requires those accounts in the test-user list. Account selection cannot override Google's policy.

Read permissions expose search/read tools in the assistant. **Enable writes with approval** requests additional Google permissions for that service; it does not authorize any particular send or modification. The assistant can then prepare proposals. Inspect the exact account, recipients, content, and affected item in the approval card inside the Assistant conversation, and choose Approve or Reject there. Settings → Connectors retains a collapsed **Recent Google actions** history for recovery. Approval can require Mike MFA. Approving sends the action immediately; it is not another draft or preview step.

| Service | Reads | Optional approved changes |
| --- | --- | --- |
| Gmail | Search messages, read messages/threads, list labels, list/read drafts | Send new plain-text email; create/replace/delete drafts; add/remove message labels; move messages to Trash |
| Calendar | List calendars, search/list events, read individual events | Create, patch, or delete a single event or recurring occurrence; Google notifies attendees |

Gmail Trash is recoverable through Gmail; permanently deleting received/sent mail is not exposed. Draft deletion removes the draft. Sent email body editing is not supported; message edits concern labels. Draft replacement is plain text and rejects drafts with attachments or reply headers, so it cannot silently discard attachments or detach a reply from its conversation. Sending attachments, sending existing drafts, email-thread replies, calendar administration, and entire recurring-series mutations are outside this version. Attendee changes replace the attendee list; the preview explicitly shows the proposed list and existing event.

## Operator setup

1. Apply `backend/migrations/20260922_01_google_workspace.sql` to the intended deployment after the Drive migration. Fresh installs include it in `backend/schema.sql`; Compose's db-init replays it. No remote database changes are performed by the tests below.
2. Enable **Gmail API** (`gmail.googleapis.com`) and **Google Calendar API** (`calendar-json.googleapis.com`) in the OAuth client's Google Cloud project. These are the REST APIs, not the Google MCP preview services.
3. Configure a Web application OAuth client. The existing Drive client may be reused. Register these exact local redirect URIs:

   ```text
   http://localhost:3000/api/user/integrations/gmail/oauth/callback
   http://localhost:3000/api/user/integrations/google-calendar/oauth/callback
   ```

   Production uses the corresponding `<API_PUBLIC_URL>/user/integrations/.../oauth/callback`. The Next.js gateway on 3000 forwards to Express on 3001. SSO retains its separate Supabase callback; adding these callbacks does not change sign-in behavior.
4. Set `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID` and `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET` in backend environment. If both are absent, the complete Drive/MCP credential profile is reused. An incomplete dedicated pair fails closed. Preserve the encryption secret used by the parent integration; never rotate it as a setup workaround.
5. Add these consent scopes. The app only requests write scopes when the user explicitly enables writes:

   | Connection | Default | Additional write permission |
   | --- | --- | --- |
   | Gmail | `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.modify` |
   | Calendar | `openid`, `email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly` | `https://www.googleapis.com/auth/calendar.events` |

   OpenID/email identifies the selected account for the connection card and approval preview. No Mike login email is passed as a hint or used to restrict account choice. Each deployment's OAuth audience and use determine Google's verification requirements; see the self-hosting guidance below, [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).
6. Restart the backend after environment changes. In Testing mode, add each intended Google account as a test user. Verify that the saved client ID matches the one used by Mike; enabling an API does not fix an OAuth redirect mismatch.

## Shipping to self-hosted deployments

This feature ships as software that each operator configures and hosts. **Every deployment supplies its own Google Cloud project and OAuth client.** Mike does not distribute a shared client secret, and releasing this PR does not require publishing one central Mike OAuth app for all installations. A successful test of our development client does not authorize a customer's client.

Choose the audience for the accounts that will connect to that installation:

| Deployment | Google configuration | Remaining operator work |
| --- | --- | --- |
| One Workspace organization, only its members | An organization-owned project with an **Internal** OAuth audience | A Workspace administrator may need to allow the client and requested services/scopes. Internal apps qualify for Google's internal-use verification exception; external Gmail accounts cannot connect. |
| Development or evaluation with personal Gmail or external accounts | **External / Testing**, with every account explicitly listed as a test user | Suitable for acceptance tests, not unattended long-term use: these scopes receive refresh tokens that expire after seven days, and test-user limits apply. |
| An installation serving accounts outside its organization | **External**, with publication/verification appropriate to that deployment | Complete branding, authorized domains, public policy information, and Google's sensitive/restricted-scope verification or establish an applicable exception. Restricted-scope server-side use can require a security assessment. Self-hosting alone is not a verification exception. |

Google also documents personal-use and development/testing exceptions. Operators must use the exception that actually describes their deployment; changing the audience to Internal to remove a warning would exclude users outside that organization. Workspace administrators can block an app even when it is verified. See [Google's audience settings](https://support.google.com/cloud/answer/15549945), [verification exceptions](https://support.google.com/cloud/answer/13464323), [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

For each production installation:

1. Apply the Drive and Workspace migrations through the normal deployment procedure; configure a stable encryption secret and keep all OAuth secrets on the backend.
2. Enable Drive, Gmail, and Calendar REST APIs in that installation's project. Configure the read scopes and only the optional write capabilities the installation intends to offer.
3. Set `FRONTEND_URL` and `API_PUBLIC_URL` to the installation's public HTTPS origins. Register all three exact callback URLs derived from `API_PUBLIC_URL`, ending in `/user/integrations/{google-drive,gmail,google-calendar}/oauth/callback`. For a same-origin gateway, `API_PUBLIC_URL=https://mike.example.com/api`; for a separate public API, it may be `https://api.example.com`. Preserve the separate Supabase SSO callback if Google sign-in is enabled.
4. Complete the audience-specific Google and Workspace-admin steps above, restart Mike, and run the acceptance checklist with synthetic data using that installation's own client.
5. Verify read-only connection, separate write consent, inline approval/rejection, token refresh after restart, account replacement, and disconnect. Keep the resulting proof with the deployment record.

Locally, the recommended callback origin is `http://localhost:3000/api`: Next's gateway forwards the server request to Express on `3001`. The fact that the frontend also uses port 3000 does not make the OAuth code exchange browser-side. Registering port 3001 instead works only when Mike is configured to emit that exact direct-API callback; changing Google's setting alone creates a mismatch.

## Technical approach and boundaries

- `googleWorkspaceAuth.ts`: explicit provider-scoped, per-user PKCE OAuth state, offline access, encrypted credentials, identity from Google's authenticated userinfo endpoint, and refresh compare-and-set. OAuth callbacks relay to a fixed `FRONTEND_URL` gateway, where completion requires the authenticated Mike user who initiated that state (including MFA when enrolled). This also works when `API_PUBLIC_URL` is a separate API origin. OAuth states expire after ten minutes and are consumed atomically with token replacement. Disconnect removes pending states before a late callback can save credentials. Refresh cannot resurrect a disconnected/replaced grant.
- `googleWorkspaceApi.ts`: allowlisted tools and strict argument schemas over Google's REST APIs. Message body conversion returns plain text; attachment content is omitted. Google responses have an 8 MiB / 30-second bound; message previews cap at 60,000 characters, thread reads at 20 messages/3,000 characters each, result pages at 25, and overall serialized tool results at 120,000 characters. Larger results require narrower searches. Truncation is explicit. Retrieved text is untrusted model context and may become part of the selected model's input and stored chat history, just like Drive.
- `googleWorkspace.ts`: write tools only create encrypted proposals with a ten-minute deadline. The model has no approval tool and cannot add an `approved` flag. The authenticated HTTP approval endpoint accepts only an action ID and decision, never replacement contents. SQL checks owner, current grant, local write opt-in, pending status, and expiry before a single atomic claim. Reconnects invalidate old proposals even for the same Google account. Approval never migrates to a newly chosen account.
- `GoogleWorkspacePanel.tsx` and `GoogleConnectionCard.tsx`: compact service cards, detail dialogs, and collapsed recovery history. Primary action review remains inline in Assistant. Shared contracts carry status and review data; API wrappers use Mike's existing authentication/error plumbing. OAuth cancellation covers in-flight start and MFA retries reopen the popup. A write upgrade waits for a new grant rather than mistakenly treating the existing read-only connection as success.
- RLS is enabled and browser roles have no direct grant/state/proposal-table or lifecycle-RPC access. Mutation routes require authentication, trusted-origin checks through existing auth middleware, and MFA when enrolled. Disconnect/cancel/reject/approve are scoped to the authenticated user. Account deletion cascades all three tables.
- Calendar patch/delete uses the reviewed ETag via `If-Match`, rejecting changes made after proposal creation. Entire recurring series are rejected. Gmail does not offer equivalent conditional draft writes: Mike checks draft message ID/history before execution, but a concurrent Gmail edit after that check can still race. Avoid editing a draft in Gmail while approving its replacement in Mike.
- Approvals are **at most once**, not exactly-once delivery. Network failures or server crashes can leave an uncertain/executing result even if Google completed the change. No automatic retry is performed; inspect Google before creating another proposal. Disconnect cannot retract an already approved request that is in flight.
- Disconnecting Gmail or Calendar deletes that local connection without Google-wide revocation, because revoking a shared OAuth client can invalidate the other services too. Remove all access in Google's account settings when desired. Drive uses the same local-only disconnect behavior. Google project-wide revocation would invalidate all services and OAuth clients sharing that grant.
- Proposals remain visible for 24 hours and older non-executing rows are removed lazily on the user's next proposal. This is not a scheduled deletion guarantee. Executing/uncertain outcomes must be investigated; tokens and stored proposal contents are never returned to the model as credentials or logged.

## Manual acceptance checklist

Use two test Google accounts and synthetic mail/events; do not use real client information. Record the commit, browser, accounts (redact as appropriate), and result for each step.

1. Sign into Mike with Google SSO. Both cards must say Not connected and the assistant must have no Gmail/Calendar tools. Repeat with password login. Merely visiting settings must not open consent.
2. Connect Gmail read-only using a different Google account from the Mike login. Verify the chooser and connected email. Connect Calendar using another account. Reload and restart: the correct service-specific identity persists.
3. Search for a synthetic email marker and read the message and thread. Verify text, headers, labels, attachment metadata, pagination, and truncation. List calendars and events in a known time range, including an all-day event and a recurring occurrence.
4. Ask to send/edit/delete while connected read-only. No mutation occurs. Enable writes explicitly and inspect Google's requested permissions. Cancelling consent must preserve the prior read-only grant. A successful upgrade changes the card only when a new grant is saved.
5. Ask for a new email to a test recipient. Verify it has not been sent. Review every recipient, subject, body, and connected account in the Assistant conversation, then approve its inline card. Verify exactly one email in Gmail Sent and the test inbox. Double-click/reload must not send it again. Reject a second proposal and verify no send.
6. Create a draft, replace its content, and delete it, approving each separately. Modify a test message's labels and move another to Trash. Try header-injection text, attachment-bearing draft replacement, and reply-draft replacement; all must be rejected safely.
7. Create a calendar event with a test attendee, then edit and delete it, approving each action. Verify invitation/update/cancellation notices. Change an event directly in Calendar after creating a proposal: approval must reject the stale version. Entire recurring-series edits must be rejected; a single occurrence is supported.
8. Let a proposal expire; approval must fail. Sign into a second Mike user and attempt the first user's action ID; it must fail. Change Google accounts or disconnect with a proposal pending; it must not execute against either account.
9. Cancel immediately after clicking Connect, close the popup, and test with popup blocking. Confirm retry works without a dangling authorization. For MFA-enrolled users, test connection, write upgrade, disconnect, approval, and rejection through the verification prompt.
10. Revoke the Google grant externally, then exercise token refresh: show reconnect guidance without exposing provider errors. Simulate a dropped mutation response: show an uncertain outcome and do not retry automatically.

Live Google consent and external mutation checks are required in addition to mocked tests. They cannot pass until the real Cloud client's APIs, callbacks, audience, and scope settings are correct.

## Automated checks

```bash
npm test --prefix backend -- src/lib/integrations/__tests__/googleWorkspace.test.ts src/__tests__/integration/googleWorkspace.routes.test.ts
bash backend/scripts/test-google-workspace-db.sh
npm test --prefix frontend -- src/app/components/settings/GoogleWorkspacePanel.test.tsx src/app/lib/mikeApi.test.ts
npm run build --prefix backend
npm run typecheck:test --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
```

The database script uses a new throwaway PostgreSQL container, no host ports, and removes it on exit. It verifies actual grants/RLS configuration, cross-user and expired/replayed/replaced authorization, migration replay, and concurrent action claims. It never connects to your configured Supabase database.

PR #434 contains the complete integration and targets `main`. It includes both migrations and all three service connections; there is no separate child PR to merge. CI verifies application builds/tests, production images, schema drift, security, Supabase, browser behavior, and the Word add-in.
