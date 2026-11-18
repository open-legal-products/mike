// Create the deployment's first account on Vercel (docs/vercel.md).
//
// A Supabase project created by the Vercel Marketplace has no Site URL for
// this deployment and its built-in mailer delivers only to the project's team,
// two messages an hour, so the normal "sign up, confirm your email" path cannot
// work until the operator configures Supabase Auth. Instead, the deploy form
// asks for MIKE_ADMIN_EMAIL and MIKE_ADMIN_PASSWORD and this script creates
// that one account already confirmed, through the Auth admin API, so the
// person who deployed can sign in immediately.
//
// Idempotent: an existing account with that email is left as it is (its
// password is never reset from the environment). Exits 0 when nothing is
// configured; a failure is logged and does not stop the server.

const email = process.env.MIKE_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.MIKE_ADMIN_PASSWORD ?? "";
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const secretKey = process.env.SUPABASE_SECRET_KEY;

function log(message) {
  console.log(`vercel-admin-user: ${message}`);
}

async function main() {
  if (!email) return;
  if (!supabaseUrl || !secretKey) {
    log("skipped: SUPABASE_URL or SUPABASE_SECRET_KEY is not set");
    return;
  }
  if (password.length < 10) {
    log("skipped: MIKE_ADMIN_PASSWORD must be at least 10 characters");
    return;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) {
    log("created the admin account");
    return;
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Status alone is enough below.
  }
  const code = body.error_code ?? body.code;
  if (response.status === 422 && (code === "email_exists" || code === "user_already_exists")) {
    return;
  }
  // Status and Auth's error code only: never the request or the address.
  log(`could not create the admin account (HTTP ${response.status}${code ? `, ${code}` : ""})`);
}

main().catch((error) => {
  log(`could not create the admin account (${error?.name ?? "error"})`);
});
