// Who may administer this Mike deployment.
//
// Instance admins are named by MIKE_ADMIN_EMAILS, a comma-separated list of
// email addresses, exactly like every other operator setting. There is no way
// to become an admin from inside the app: the list lives with the deployment,
// so a compromised account cannot promote itself, and a self-hoster who runs
// a single-user install simply lists their own address.
//
// Only a CONFIRMED address counts. requireAuth puts "" in res.locals.userEmail
// for an account that has not proved it owns its address, and "" is never an
// admin, so signing up as an admin's address before they do grants nothing.

export function instanceAdminEmails(): string[] {
  return (process.env.MIKE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isInstanceAdmin(email: unknown): boolean {
  if (typeof email !== "string" || !email) return false;
  return instanceAdminEmails().includes(email.trim().toLowerCase());
}
