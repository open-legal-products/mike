# CourtListener integration

Mike can use CourtListener for US case-law citation verification, case fetching,
targeted opinion search, and case-law panels in assistant responses.

## Enable live access

Set `COURTLISTENER_API_TOKEN` in `backend/.env` and restart the backend. When an
instance does not provide a global token, users can add their own from
**Settings > Connectors > Built in > CourtListener**.

CourtListener is a built-in connector. Its switch on the Connectors page turns
case-law research on or off for the user, and its card shows whether the tools
will use the user's own token or the deployment's, or still need one. Unlike the connections under **Installed**, it is not limited to the
Personal workspace: the assistant can use it in assistant and project chats in
every workspace. Tabular review and the Word add-in do not offer it.

Fresh databases created from `backend/schema.sql` already include the required
CourtListener tables. Existing deployments must apply the matching dated
migration from `backend/migrations/` before enabling the integration.

Live requests remain subject to CourtListener's API limits.

## Optional bulk data

Set `COURTLISTENER_BULK_DATA_ENABLED=true` to make Mike try local Supabase and
R2 data before falling back to CourtListener's API:

- Citation metadata is read from `public.courtlistener_citation_index`.
- Case-cluster metadata is read from
  `public.courtlistener_opinion_cluster_index`.
- Cached opinion JSON is read from
  `courtlistener/opinions/by-cluster/{clusterId}/{opinionId}.json` in R2.

If bulk data has not been imported, leave
`COURTLISTENER_BULK_DATA_ENABLED=false`. Live CourtListener tools still work
with a valid token.

## Troubleshooting

If tools report a missing token, confirm `COURTLISTENER_API_TOKEN` is present
in `backend/.env` or add a user token under **Settings > Connectors**, then
restart the backend after changing the environment.

If bulk lookup does not return local results, confirm that:

- `COURTLISTENER_BULK_DATA_ENABLED=true`;
- both CourtListener index tables contain data; and
- opinion JSON exists beneath `courtlistener/opinions/by-cluster/` in R2.

Mike falls back to the live API when local bulk data is unavailable and a token
is configured.
