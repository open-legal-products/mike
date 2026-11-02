import type { ReactNode } from "react";

export function SettingsHeading({
  children,
  id,
  tone = "default",
}: {
  children: ReactNode;
  id?: string;
  tone?: "default" | "danger";
}) {
  return (
    <h2
      id={id}
      // Settings search scrolls a heading into view and focuses it; the
      // margin keeps it clear of the top edge and the ring reads as a mark,
      // not a control.
      className={`scroll-mt-6 rounded-sm font-sans text-xl font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
        tone === "danger" ? "text-red-600" : "text-gray-900"
      }`}
    >
      {children}
    </h2>
  );
}
