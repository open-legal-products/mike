import { z } from "zod";

// Accept DNS domains only, never email addresses, URLs, wildcards or ports.
export const ssoDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

export function ssoConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.SSO_ENABLED?.trim().toLowerCase() === "true";
  if (!enabled) {
    return {
      enabled: false,
      allowedDomains: null,
    };
  }
  const allowedDomains = env.SSO_ALLOWED_DOMAINS?.trim()
    ? env.SSO_ALLOWED_DOMAINS.split(",").map((domain) =>
        ssoDomainSchema.parse(domain),
      )
    : null;
  return {
    enabled,
    allowedDomains,
  };
}
