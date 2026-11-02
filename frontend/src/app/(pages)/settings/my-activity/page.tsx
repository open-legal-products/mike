"use client";

import { useRouter } from "next/navigation";
import { AuditHistory } from "@/app/components/history/AuditHistory";

export default function MyActivitySettingsPage() {
  const router = useRouter();
  return <AuditHistory onBack={() => router.push("/settings")} />;
}
