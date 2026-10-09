# MCP connectors

Mike connects to remote [Model Context Protocol](https://modelcontextprotocol.io)
servers from **Settings > Connectors**. Installed connectors appear under
**Installed**. Hosted providers appear under **Discover**, and an arbitrary
remote server can be added with **+ Custom**.

## Authentication pathways

### Dynamic client registration

Most hosted MCP servers support OAuth Dynamic Client Registration (DCR). A
user clicks **Add** in Discover and completes the provider's consent screen;
the Mike deployment does not need provider-specific credentials. Airtable,
Lawve, Linear, and Notion use this pathway.

Servers that use a bearer token or custom headers can be added through
**+ Custom**. Credentials are encrypted at rest. Failed registration does not
leave an incomplete connector installed.

### Pre-configured OAuth clients

Some providers do not support DCR. The person operating Mike must create one
OAuth client with the provider and configure its credentials in
`backend/.env`. Each Mike user can then authorize their own provider account.

- [Slack](#slack)
- [Google-hosted MCP servers](#google-hosted-mcp-servers)

If the deployment is not configured, Mike rejects the connector before saving
it. The warning links to this guide rather than assuming a callback URI for the
deployment.

## Redirect URIs

MCP callback URIs are derived from `API_PUBLIC_URL`, which must be the
browser-reachable frontend gateway including its `/api` prefix. The frontend
proxies `/api/*` to the backend, so an internal backend port or container name
must not appear in a provider configuration.

| Deployment | `API_PUBLIC_URL` | Provider redirect URI |
| --- | --- | --- |
| Local development | `http://localhost:3000/api` | `http://localhost:3000/api/user/mcp-connectors/oauth/callback` |
| Production | `https://<your-mike-host>/api` | `https://<your-mike-host>/api/user/mcp-connectors/oauth/callback` |

The provider redirect URI must match byte-for-byte. Some providers impose
additional requirements; Slack requires HTTPS.

## Slack

Slack's hosted endpoint is `https://mcp.slack.com/mcp`. Slack does not support
DCR, so the deployment needs a Slack app created by someone with app-creation
rights in the workspace.

1. Open [Slack app management](https://api.slack.com/apps) and create an app.
   The quickest route is **From an app manifest**: paste
   [`slack-mcp-app-manifest.example.json`](slack-mcp-app-manifest.example.json)
   and replace its redirect-URL placeholder. The manifest configures the bot
   user, the agent feature (`features.assistant_view`), and OAuth scopes.
2. Under the app's **Agents** settings, enable **Slack MCP Server**. Under
   **OAuth & Permissions**, enable PKCE. These settings are not represented in
   the app manifest and must be enabled manually.
3. Register
   `https://<your-mike-host>/api/user/mcp-connectors/oauth/callback` as a
   redirect URI. Slack requires HTTPS. For local development, run an HTTPS
   tunnel against the frontend on port 3000, set
   `API_PUBLIC_URL=https://<tunnel-host>/api`, and register the matching tunnel
   callback. Quick-tunnel hostnames change when restarted, so update both
   values together.
4. Set `SLACK_MCP_OAUTH_CLIENT_ID` and
   `SLACK_MCP_OAUTH_CLIENT_SECRET` in `backend/.env`, then restart the backend.
5. In Mike, go to **Settings > Connectors > Discover**, click **Add** on Slack,
   and approve the consent screen. A workspace owner or administrator may
   need to approve the app first.

Slack requests read/search scopes and several write scopes, so the assistant
can post and edit messages. See [write actions](#write-actions-and-approvals)
to require approval for each one. If granting write scopes is not acceptable,
remove the corresponding user scopes from the app manifest.

## Google-hosted MCP servers

Google-hosted MCP servers under `*.googleapis.com` also require a
pre-configured OAuth client.

1. In Google Cloud Console, create an OAuth client under **APIs & Services >
   Credentials > Create credentials > OAuth client ID > Web application**.
2. Register the MCP callback URI described above.
3. Enable both the base API and its MCP service in the same project. For Google
   Drive, these are `drive.googleapis.com` and `drivemcp.googleapis.com`.
4. Set `GOOGLE_MCP_OAUTH_CLIENT_ID` and
   `GOOGLE_MCP_OAUTH_CLIENT_SECRET` in `backend/.env`, then restart the backend.

Google MCP endpoint paths may be versioned. Use the provider's documented URL;
for example, the Drive endpoint is
`https://drivemcp.googleapis.com/mcp/v1`, not `/mcp`.

## Security and tool controls

- Connector bearer tokens, custom headers, and OAuth tokens are encrypted at
  rest using `MCP_CONNECTORS_ENCRYPTION_SECRET`.
- Remote URLs are subject to Mike's outbound SSRF protections.
- Connector tools are cached after successful registration and can be enabled
  or disabled from the connector's Manage dialog.

## Write actions and approvals

Every connector — MCP servers such as Slack, and Google Drive, Gmail and
Calendar — has write access by default: the assistant can use a tool that
changes data as soon as the connector is installed. A tool counts as a write
unless its server explicitly marks it read-only and non-destructive; the Manage
dialog labels those tools **Write**.

Turn on **Read-only** in the Manage dialog to disable every write tool. The
write switches stay off and unavailable while this setting is on; read tools
keep their individual settings. Turning it off restores the saved per-tool
choices. This also covers newly discovered write tools and pending approvals,
and survives tool refreshes and Google reconnection. MCP write classification
uses the server's annotations, so servers must report their tools accurately.

Existing deployments must apply
`backend/migrations/20261002_03_connector_read_only.sql` and
`backend/migrations/20261002_05_mcp_oauth_grants.sql`. Fresh installations
already include these settings in `backend/schema.sql`.

Turn on **Ask for permission for write actions** in a connector's Manage
dialog to review each write first. The assistant's turn then pauses with an
approval in the same popup it uses for questions, showing the exact action and
its arguments. **Approve** runs that action and the turn continues with its
result; **Reject** tells the assistant it did not run. The server runs the
action it stored with the approval, never arguments sent by the browser, and
each approval runs at most once. It does not run if the connector or tool was
turned off, deleted, or replaced in the meantime. Changing the server URL,
credentials, or authorized account invalidates a pending approval. Routine
OAuth token refresh does not.

Approvals are available in the Mike assistant and project chats. The Word
add-in and tabular review cannot show them, so a write that needs approval is
refused there with an explanation.

Tool results, including connector content, are untrusted: a message or email
can contain instructions meant for the assistant. Leaving writes unapproved
lets such content trigger actions as the connected account. Turn the setting
on for connectors whose actions you want to review.
