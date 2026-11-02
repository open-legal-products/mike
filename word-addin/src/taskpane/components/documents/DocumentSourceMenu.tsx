import React from "react";
import { ClipboardCheck, Loader2, Plus, Waypoints } from "lucide-react";
import { ComposerButton } from "../primitives/ComposerButton";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@mike/dropdown-ui";
import desktopIcon from "@icons/desktop.svg";
import cloudIcon from "@icons/cloud.svg";

interface DocumentSourceMenuProps {
  attachedCount: number;
  disabled?: boolean;
  uploading?: boolean;
  onLocalFiles: () => void;
  onWebFiles: () => void;
  onWorkflows: () => void;
  onPlaybooks: () => void;
}

export function DocumentSourceMenu({
  attachedCount,
  disabled = false,
  uploading = false,
  onLocalFiles,
  onWebFiles,
  onWorkflows,
  onPlaybooks,
}: DocumentSourceMenuProps): React.ReactElement {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <ComposerButton
          disabled={disabled || uploading}
          active={attachedCount > 0}
          aria-label="Add documents"
          title="Add documents"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : attachedCount > 0 ? (
            <span className="font-medium tabular-nums">{attachedCount}</span>
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </ComposerButton>
      </DropdownTrigger>
      <DropdownContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="min-w-36"
      >
        <DropdownItem onSelect={onLocalFiles}>
          <img
            src={desktopIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-4 w-4 shrink-0 object-contain"
          />
          Desktop Files
        </DropdownItem>
        <DropdownItem onSelect={onWebFiles}>
          <img
            src={cloudIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-4 w-4 shrink-0 object-contain"
          />
          Web files
        </DropdownItem>
        <DropdownItem onSelect={onWorkflows}>
          <Waypoints className="h-4 w-4 shrink-0 text-gray-500" />
          Workflows
        </DropdownItem>
        <DropdownItem onSelect={onPlaybooks}>
          <ClipboardCheck
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-gray-500"
          />
          Playbooks
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
