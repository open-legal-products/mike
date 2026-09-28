import React, { useState } from "react";
import type { WordChatOpenHandler } from "../../lib/wordChatTypes";
import {
  Check,
  ChevronLeft,
  Ellipsis,
  Menu,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  LiquidActionRow,
  LiquidIconButton,
  LiquidTextButton,
} from "../primitives/LiquidActionRow";
import {
  HeaderButtonUI,
  HeaderButtonsUI,
} from "@mike/header-buttons-ui";
import chatIcon from "@icons/features/chat.svg";
import quickActionsIcon from "@icons/features/quick-actions.svg";
import workflowIcon from "@icons/features/workflow.svg";
import chatHistoryIcon from "@icons/features/chat-history.svg";
import settingsIcon from "@icons/settings.svg";
import signOutIcon from "@icons/sign-out.svg";
import { ChatHistoryDropdown } from "../history/ChatHistoryDropdown";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@mike/dropdown-ui";
import type { WordChatStorageMode } from "../../lib/wordChatSettings";

export type AddinSection =
  | "chat"
  | "actions"
  | "workflows"
  | "history"
  | "settings";

interface FloatingHeaderProps {
  section: AddinSection;
  onSectionChange: (section: AddinSection) => void;
  onNewChat: () => void;
  hasActiveChat: boolean;
  onSelectHistoryChat: WordChatOpenHandler;
  workflowDetailOpen?: boolean;
  onWorkflowBack?: () => void;
  onOpenWorkflowDetails?: () => void;
  onDeleteWorkflow?: () => void;
  canDeleteWorkflow?: boolean;
  onUseWorkflow?: () => void;
  onNewWorkflow?: () => void;
  onNewQuickAction?: () => void;
  onSignOut: () => void;
  wordDocumentId: string;
  wordChatStorage: WordChatStorageMode;
  wordChatOwnerId: string;
}

const SECTIONS = [
  { value: "chat" as const, label: "Assistant", icon: chatIcon },
  {
    value: "history" as const,
    label: "Chat History",
    icon: chatHistoryIcon,
  },
  {
    value: "actions" as const,
    label: "Quick Actions",
    icon: quickActionsIcon,
  },
  { value: "workflows" as const, label: "Workflows", icon: workflowIcon },
  { value: "settings" as const, label: "Settings", icon: settingsIcon },
];

export function FloatingHeader({
  section,
  onSectionChange,
  onNewChat,
  hasActiveChat,
  onSelectHistoryChat,
  workflowDetailOpen = false,
  onWorkflowBack,
  onOpenWorkflowDetails,
  onDeleteWorkflow,
  canDeleteWorkflow = false,
  onUseWorkflow,
  onNewWorkflow,
  onNewQuickAction,
  onSignOut,
  wordDocumentId,
  wordChatStorage,
  wordChatOwnerId,
}: FloatingHeaderProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const [workflowActionsOpen, setWorkflowActionsOpen] = useState(false);

  return (
    <header
      data-testid="floating-header"
      className="pointer-events-none absolute inset-x-0 top-0 z-40 isolate flex items-center justify-between gap-3 p-3"
    >
      {/* Content fades out under the header. This used to ramp the blur down
          in four stacked backdrop-blur layers (1/2/4/8px), but every
          backdrop-filter re-samples whatever is moving behind it on each
          frame — in WKWebView that made the streaming transcript pay for four
          full-width re-samples per scrolled frame. One blurred layer whose
          mask alpha ramps down through several stops is the standard
          single-layer approximation of a progressive blur: the cross-fade
          from blurred to sharp reads as the blur easing off, and the mask
          reaches zero well before the pane's bottom edge so no seam is left
          to catch the eye. -webkit-mask-image is spelled out because
          WKWebView still wants the prefixed form. */}
      <div
        aria-hidden="true"
        data-testid="header-scrim"
        className="pointer-events-none absolute -bottom-2 left-0 right-2 top-0 z-0"
      >
        <div className="absolute inset-0 backdrop-blur-[8px] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_16%,rgba(0,0,0,0.55)_46%,rgba(0,0,0,0.2)_72%,transparent_100%)] [mask-image:linear-gradient(to_bottom,black_0%,black_16%,rgba(0,0,0,0.55)_46%,rgba(0,0,0,0.2)_72%,transparent_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.85)_0%,rgba(255,255,255,0.62)_48%,rgba(255,255,255,0.22)_76%,rgba(255,255,255,0)_100%)]" />
      </div>

      <div className="relative z-10 flex items-center gap-2">
        <Dropdown open={menuOpen} onOpenChange={setMenuOpen}>
          <LiquidActionRow className="pointer-events-auto">
            <DropdownTrigger asChild>
              <LiquidIconButton
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                title={menuOpen ? "Close menu" : "Menu"}
              >
                {menuOpen ? (
                  <X className="h-4 w-4" />
                ) : (
                  <Menu className="h-4 w-4" />
                )}
              </LiquidIconButton>
            </DropdownTrigger>
          </LiquidActionRow>
          <DropdownContent align="start" sideOffset={8} className="min-w-44">
            {SECTIONS.map((item) => {
              return (
                <DropdownItem
                  key={item.value}
                  onSelect={() => onSectionChange(item.value)}
                  selected={section === item.value}
                >
                  <img
                    src={item.icon}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="h-4 w-4 shrink-0 object-contain"
                  />
                  <span className="min-w-0 flex-1">{item.label}</span>
                </DropdownItem>
              );
            })}
            <DropdownSeparator />
            <DropdownItem onSelect={onSignOut}>
              <img
                src={signOutIcon}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-4 w-4 shrink-0 object-contain"
              />
              <span className="min-w-0 flex-1">Sign out</span>
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
        {workflowDetailOpen && (
          <LiquidActionRow
            data-testid="workflow-back-bubble"
            className="pointer-events-auto"
          >
            <LiquidTextButton
              onClick={onWorkflowBack}
              aria-label="Back to workflows"
              title="Back to workflows"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Workflows
            </LiquidTextButton>
          </LiquidActionRow>
        )}
      </div>

      {section === "chat" ? (
        <HeaderButtonsUI className="pointer-events-auto relative z-10">
          {hasActiveChat && (
            <HeaderButtonUI
              iconOnly
              onClick={onNewChat}
              aria-label="New chat"
              title="New chat"
            >
              <Plus className="h-4 w-4" />
            </HeaderButtonUI>
          )}
          <ChatHistoryDropdown
            onSelect={onSelectHistoryChat}
            documentId={wordDocumentId}
            ownerId={wordChatOwnerId}
            storageMode={wordChatStorage}
          />
        </HeaderButtonsUI>
      ) : workflowDetailOpen ? (
        <HeaderButtonsUI className="pointer-events-auto relative z-10">
          <Dropdown
            open={workflowActionsOpen}
            onOpenChange={setWorkflowActionsOpen}
          >
            <DropdownTrigger asChild>
              <HeaderButtonUI
                iconOnly
                aria-label="Workflow actions"
                title="Workflow actions"
              >
                <Ellipsis className="h-4 w-4" />
              </HeaderButtonUI>
            </DropdownTrigger>
            <DropdownContent align="end" sideOffset={8} className="min-w-40">
              <DropdownItem onSelect={() => onOpenWorkflowDetails?.()}>
                <Pencil className="h-3.5 w-3.5" />
                <span>Edit details</span>
              </DropdownItem>
              <DropdownItem
                disabled={!canDeleteWorkflow}
                onSelect={() => onDeleteWorkflow?.()}
                className="text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete</span>
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
          <LiquidTextButton onClick={onUseWorkflow}>
            <Check className="h-3.5 w-3.5" />
            Use
          </LiquidTextButton>
        </HeaderButtonsUI>
      ) : section === "history" ? (
        <HeaderButtonsUI className="pointer-events-auto relative z-10">
          <HeaderButtonUI
            iconOnly
            onClick={onNewChat}
            aria-label="New chat"
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </HeaderButtonUI>
        </HeaderButtonsUI>
      ) : section === "workflows" ? (
        <HeaderButtonsUI className="pointer-events-auto relative z-10">
          <HeaderButtonUI
            iconOnly
            onClick={onNewWorkflow}
            aria-label="New workflow"
            title="New workflow"
          >
            <Plus className="h-4 w-4" />
          </HeaderButtonUI>
        </HeaderButtonsUI>
      ) : section === "actions" ? (
        <HeaderButtonsUI className="pointer-events-auto relative z-10">
          <HeaderButtonUI
            iconOnly
            onClick={onNewQuickAction}
            aria-label="New quick action"
            title="New quick action"
          >
            <Plus className="h-4 w-4" />
          </HeaderButtonUI>
        </HeaderButtonsUI>
      ) : null}
    </header>
  );
}
