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

Slack requests read/search scopes and several write scopes. Mike currently
keeps tools Slack marks as writes disabled because it does not yet have a
human-confirmation step for MCP write tools. If granting those scopes is not
acceptable, remove the corresponding user scopes from the app manifest.

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
  or disabled from the connector details view.
- Tools requiring human confirmation remain disabled until Mike supports that
  confirmation flow.
