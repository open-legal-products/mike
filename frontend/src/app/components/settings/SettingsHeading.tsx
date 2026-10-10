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
      className={`font-sans text-xl font-medium ${
        tone === "danger" ? "text-red-600" : "text-gray-900"
      }`}
    >
      {children}
    </h2>
  );
}
