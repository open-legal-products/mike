/**
 * How long an invitation addressed to an email stays claimable: an
 * organization invitation (lib/orgs.ts) and a pending direct share
 * (lib/shareInvitations.ts) alike.
 */
export const INVITATION_TTL_DAYS = 14;

/** When an invitation made now stops being claimable, as an ISO timestamp. */
export function invitationExpiry(now = Date.now()): string {
    return new Date(now + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
