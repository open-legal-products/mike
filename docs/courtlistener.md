# CourtListener integration

Mike can use CourtListener for US case-law citation verification, case fetching,
targeted opinion search, and case-law panels in assistant responses.

## Enable live access

CourtListener is a connector, and like every connector it is per workspace
(see [Connectors](connectors.md#workspace-availability)). A user adds it from
**Settings > Connectors > Discover > CourtListener** by saving their own API
token for the selected workspace; Mike stores it encrypted in
`user_courtlistener_connections`, separately for Personal and each
organization. An organization can also hold a token for its members, which
its admins save with its other API keys; it takes precedence over a member's
own token in that organization. A member's token for an organization is a
connector they set up in that workspace, so it is still used there even though
their personal model-provider keys never are. There is no deployment-wide
token: `COURTLISTENER_API_TOKEN` is no longer read from `backend/.env`.

Once added, CourtListener appears under **Installed**. Its switch turns case-law
research on or off for that workspace, and **Manage** replaces or deletes the
user's own token. The assistant is given the CourtListener tools in assistant
and project chats only while the workspace's switch is on and the connector is
installed there. Tabular review and the Word add-in do not offer it. Opening a
cited case uses the token of the workspace the citation came from.

The `20261022_01_workspace_connectors.sql` migration copies each user's
existing token and switch to Personal and to every team organization they
belong to, so research keeps working where it worked before.

Fresh databases created from `backend/schema.sql` already include the required
CourtListener tables. Existing deployments must apply the matching dated
migration from `backend/migrations/` before enabling the integration.

Live requests remain subject to CourtListener's API limits.

## Optional bulk data

Set `COURTLISTENER_BULK_DATA_ENABLED=true` to make Mike try local Supabase and
R2 data before falling back to CourtListener's API. CourtListener is then
installed for every user without a token, and while it is switched on its
**Manage** dialog reads "Bulk data installed and in use". Switched off without
a token of the user's own, it moves back to **Discover**, where **Add** turns
it on again (as it does when the organization supplies the token). A user's
own token still adds the live API fallback and opinion search, and keeps the
connector under **Installed** while it is off:

- Citation metadata is read from `public.courtlistener_citation_index`.
- Case-cluster metadata is read from
  `public.courtlistener_opinion_cluster_index`.
- Cached opinion JSON is read from
  `courtlistener/opinions/by-cluster/{clusterId}/{opinionId}.json` in R2.

If bulk data has not been imported, leave
`COURTLISTENER_BULK_DATA_ENABLED=false`. Live CourtListener tools still work
with a user's or organization's token.

## Troubleshooting

If tools report a missing token, add CourtListener with a token under
**Settings > Connectors**. A token in `backend/.env` is ignored.

If bulk lookup does not return local results, confirm that:

- `COURTLISTENER_BULK_DATA_ENABLED=true`;
- both CourtListener index tables contain data; and
- opinion JSON exists beneath `courtlistener/opinions/by-cluster/` in R2.

Mike falls back to the live API when local bulk data is unavailable and the
user or their organization has saved a token.
