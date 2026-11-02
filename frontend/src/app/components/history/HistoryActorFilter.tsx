"use client";

import { getAuditActors, type AuditActor } from "@/app/lib/mikeApi";
import { PersonFilter } from "@/app/components/shared/PersonFilter";

/** Search and select an exact audit actor, loading additional people on scroll. */
export function HistoryActorFilter({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: AuditActor | null;
  onChange: (value: AuditActor | null) => void;
}) {
  return (
    <PersonFilter
      value={value}
      onChange={onChange}
      loadPeople={(query, signal) => getAuditActors({ orgId, ...query }, signal)}
    />
  );
}
