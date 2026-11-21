# Safe Local Testing

Mike is a young open-source legal AI project. Until you have reviewed your
deployment and data flows, test it with disposable infrastructure and synthetic
documents only.

## Use Disposable Test Resources

Create separate test resources for Mike:

- a throwaway Supabase project
- a throwaway S3-compatible storage bucket, such as Cloudflare R2
- disposable model-provider API keys with low spending limits
- a test email account

Do not use production Supabase projects, production storage buckets, firm API
keys, or real client documents for initial testing.

## Keep Secrets Out of the Frontend

The browser does not need Supabase configuration. Session handling and all
Supabase keys stay server-side.

For frontend testing, `frontend/.env.local` should normally contain only:

```env
API_BASE_URL=http://localhost:3001
```

Keep the Supabase service-role key in `backend/.env` only:

```env
SUPABASE_SECRET_KEY=your-supabase-service-role-key
SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key
```

Model-provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENROUTER_API_KEY` should also stay in `backend/.env`.

## Test With Synthetic Documents

Use fake or public sample documents when testing:

- synthetic NDAs
- sample contracts
- public court documents
- dummy PDF/DOCX files

Do not upload privileged, confidential, client, matter, personnel, or firm
knowledge-management material until you are comfortable with the deployment's
storage, logging, deletion, and model-provider behavior.

## Confirm Environment Files Are Not Tracked

Before running or committing changes, check:

```bash
git status --short
```

Stop if `.env`, `.env.local`, or any file containing secrets appears in the
output.

## Start With Non-LLM Flows

If you do not want to use model-provider keys yet, use dummy provider values and
test only the non-LLM flows first:

- account creation against a test Supabase project
- project creation
- file upload with synthetic documents
- folder organization
- document deletion

Then add one disposable, capped model-provider key and test assistant behavior
with synthetic documents.

## Playbook Review Recovery Regressions

After applying the current schema to a disposable database, run the same
transaction regression as schema-drift CI:

```bash
psql "$SUPABASE_TEST_DB_URL" -X --set ON_ERROR_STOP=1 \
  -f backend/scripts/test-playbook-review-publication.sql
```

It rolls back all synthetic rows and temporary fault-injection triggers. It
checks exact finding/edit mapping, replay, source/status guards and atomic
rollback, including extraction rows and queued jobs. This sequential script
does not establish concurrent lock behavior or lost-network-response handling.

The actual-handler crash regression requires loopback PostgreSQL and a local
Supabase REST API (or PostgREST mounted beneath `/rest/v1`), `psql` in `PATH`,
and the locked backend dependencies. Set `SUPABASE_TEST_URL`,
`SUPABASE_TEST_DB_URL` and `SUPABASE_TEST_SERVICE_ROLE_KEY` for that isolated
stack, then run from `backend/`:

```bash
PLAYBOOK_REAL_REVIEW=1 PLAYBOOK_NATIVE_EVIDENCE_DIR=/tmp/mike-review-evidence \
  npm test -- src/modules/playbooks/__tests__/playbookRecovery.supabase.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

This test uses synthetic model output and disk object storage, but the real
review handler, DOCX matcher, Supabase client and database. It kills the child
process after the committed RPC response and invokes the job handler in a
fresh process with attempt two. It does not test the queue scheduler's claim
operation. The same test on the pre-fix source exposes the missing version and
finding links. Unlike the SQL test, it retains unique synthetic rows and local
DOCX evidence for inspection. Remove them only when done with the disposable
test environment. Never use a production database or real storage keys.

## Clean Up After Testing

After testing, delete:

- uploaded objects from the storage bucket
- test Supabase rows or the whole test Supabase project
- disposable model-provider keys
- local `.env` files that contain secrets

For legal-document workflows, deletion semantics matter. Verify that your
storage bucket no longer contains test document objects after delete flows.
