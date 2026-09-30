"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import { Modal } from "@/app/components/modals/Modal";
import { ConnectorCard } from "./ConnectorCard";

/** Add goes straight to OAuth; connected cards retain account management. */
export function GoogleConnectionCard({
  provider,
  name,
  connected,
  loading,
  accountEmail,
  summary,
  onConnect,
  connecting = false,
  error,
  connectionNotice,
  onClose,
  children,
}: {
  provider: "google-drive" | "gmail" | "google-calendar";
  name: string;
  connected: boolean;
  loading: boolean;
  accountEmail?: string | null;
  summary: string;
  onConnect?: () => void;
  connecting?: boolean;
  error?: string | null;
  connectionNotice?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConnectorCard
        name={name}
        icon={
          <Image
            src={`/icons/integrations/${provider}.png`}
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
            unoptimized
            className="h-6 w-6 object-contain"
          />
        }
        connected={connected}
        loading={loading}
        accountEmail={accountEmail}
        summary={summary}
        connecting={!open && connecting}
        error={!open ? error : null}
        notice={!connected ? connectionNotice : null}
        onAdd={onConnect}
        onCancel={onClose}
        onManage={() => setOpen(true)}
      />
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        breadcrumbs={["Connectors", name]}
        size="md"
      >
        <div className="min-h-0 flex-1 overflow-y-auto pb-5">{children}</div>
      </Modal>
    </>
  );
}
