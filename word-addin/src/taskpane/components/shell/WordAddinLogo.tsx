import React from "react";
import { MikeIcon } from "../../../shared/chat/mike-icon";
import { cn } from "../../../shared/lib/utils";
import { APP_NAME } from "../../../shared/branding";

interface WordAddinLogoProps {
  size?: "md" | "lg";
  className?: string;
}

/** Mike logo lockup shared by branded Word add-in surfaces. */
export function WordAddinLogo({
  size = "md",
  className,
}: WordAddinLogoProps): React.ReactElement {
  const large = size === "lg";
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <MikeIcon size={large ? 30 : 22} />
      <span
        className={cn(
          "font-serif font-light text-foreground",
          large ? "text-4xl" : "text-2xl"
        )}
      >
        {APP_NAME}
      </span>
    </div>
  );
}
