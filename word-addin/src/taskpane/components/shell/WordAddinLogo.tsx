import React from "react";
import { SambanovaLogo } from "../../../shared/chat/sambanova-logo";
import { cn } from "../../../shared/lib/utils";

interface WordAddinLogoProps {
  size?: "md" | "lg";
  className?: string;
}

/** SambaNova logo lockup shared by branded Word add-in surfaces. */
export function WordAddinLogo({
  size = "md",
  className,
}: WordAddinLogoProps): React.ReactElement {
  const large = size === "lg";
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <SambanovaLogo size={large ? 30 : 22} />
      <span
        className={cn(
          "font-serif font-light text-foreground",
          large ? "text-4xl" : "text-2xl"
        )}
      >
        SambaNova
      </span>
    </div>
  );
}
