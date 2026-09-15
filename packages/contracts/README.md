# Shared contracts

`@mike/contracts` contains authored TypeScript declarations shared by the API,
web app, and Word add-in. It has no runtime dependencies or build output.
Each application's TypeScript paths resolve the same `index.d.ts`.

Keep serialized assistant events, input requests, source documents, and shared
edit records here. Keep client rendering state (streaming indicators, React
keys, loading states) in the client. The web and Word event models derive
their payloads from these declarations and add their own display state.
`WordDocumentEdit` is the normalized edit record used by the Word API adapter;
database columns are mapped to that record at the boundary.

When changing a shared payload:

1. Update the declaration and the producing backend operation together.
2. Update web/Word adapters and their regression tests.
3. Run `npm run typecheck:contracts --prefix backend`, application typechecks,
   and relevant stream/API tests. Existing runtime validation remains required
   for untrusted or legacy JSON; a TypeScript assertion is not validation.

Backend and frontend Docker builds use the repository root as their context
so the declarations are available during compilation.
