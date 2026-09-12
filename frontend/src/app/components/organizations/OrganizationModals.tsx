"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCw, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { AddUserInput } from "@/app/components/shared/AddUserInput";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { PillButton } from "@/app/components/ui/pill-button";
import {
  cancelOrgInvitation,
  createOrg,
  createOrgInvitation,
  deleteOrg,
  resendOrgInvitation,
  updateOrg,
  type Org,
  type OrgInvitation,
} from "@/app/lib/mikeApi";
import { type OrgRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";

function friendlyError(error: unknown, fallback: string) {
  return userFacingApiError(error, fallback);
}

const PAPEL_KEYS: Record<OrgRole, string> = {
  admin: "papelAdmin",
  member: "papelMembro",
};

export function CreateOrganizationModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (org: Org) => void;
}) {
  const t = useTranslations("organizations.modais");
  const tg = useTranslations("organizations.geral");
  const [name, setName] = useState("");
  const [memberEmails, setMemberEmails] = useState<string[]>([]);
  const [createdOrg, setCreatedOrg] = useState<Org | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMemberEmails([]);
    setCreatedOrg(null);
    setError(null);
  }, [open]);

  const trimmedName = name.trim();
  async function submit() {
    if (creating) return;
    if (createdOrg) {
      onCreated(createdOrg);
      return;
    }
    if (!trimmedName) return;
    setCreating(true);
    setError(null);
    try {
      const org = await createOrg(trimmedName);
      if (memberEmails.length === 0) {
        onCreated(org);
        return;
      }
      const results = await Promise.allSettled(
        memberEmails.map((email) =>
          createOrgInvitation(org.id, email, "member"),
        ),
      );
      if (results.some((result) => result.status === "rejected")) {
        setCreatedOrg(org);
        setError(t("criar.convitesNaoEnviados"));
        return;
      }
      onCreated(org);
    } catch (err) {
      setError(friendlyError(err, t("criar.erroCriar")));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        breadcrumbs={[tg("organizacoes"), tg("novaOrganizacao")]}
        primaryAction={{
          label: createdOrg
            ? t("criar.abrirOrganizacao")
            : creating
              ? t("criar.criando")
              : tg("criar"),
          icon: creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : undefined,
          onClick: () => void submit(),
          disabled: (!trimmedName && !createdOrg) || creating,
        }}
      >
        <div className="space-y-5 py-1">
          <div>
            <FieldLabel htmlFor="new-organization-name">
              {t("criar.nomeOrganizacao")}
            </FieldLabel>
            <FormTextInput
              id="new-organization-name"
              autoFocus
              value={name}
              placeholder={t("criar.placeholderNome")}
              disabled={creating || createdOrg !== null}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <p className="mt-2 text-xs text-gray-400">
              {t("criar.primeiroAdministrador")}
            </p>
          </div>

          <div>
            <FieldLabel as="p">{t("criar.convidarMembros")}</FieldLabel>
            <AddUserInput
              requireExistingUser={false}
              busy={creating || createdOrg !== null}
              placeholder={t("criar.placeholderAdicionarEmail")}
              submitLabel={tg("adicionarMembro")}
              validateEmail={(email) =>
                memberEmails.includes(email)
                  ? t("criar.emailRepetido")
                  : null
              }
              onAdd={(user) => {
                setMemberEmails((current) => [...current, user.email]);
                setError(null);
                return true;
              }}
            />
            {memberEmails.length > 0 ? (
              <div className="mt-2 space-y-1">
                {memberEmails.map((email) => (
                  <div
                    key={email}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-gray-600 hover:bg-app-surface-hover"
                  >
                    <span className="min-w-0 flex-1 truncate">{email}</span>
                    <button
                      type="button"
                      aria-label={t("criar.removerEmail", { email })}
                      disabled={creating || createdOrg !== null}
                      onClick={() =>
                        setMemberEmails((current) =>
                          current.filter((value) => value !== email),
                        )
                      }
                      className="rounded-full p-1 text-gray-400 hover:bg-app-surface-active hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-xs text-gray-400">
              {t("criar.avisoConvites")}
            </p>
          </div>
        </div>
      </Modal>
      <WarningPopup
        open={open && error !== null}
        title={
          createdOrg
            ? t("criar.algumasConvitesPendentes")
            : t("criar.organizacaoNaoCriada")
        }
        message={error}
        onClose={() => setError(null)}
      />
    </>
  );
}

export function InviteOrganizationMemberModal({
  open,
  org,
  invitations,
  onClose,
  onChanged,
}: {
  open: boolean;
  org: Org;
  invitations: OrgInvitation[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("organizations.modais");
  const tg = useTranslations("organizations.geral");
  const [role, setRole] = useState<OrgRole>("member");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = invitations.filter(
    (invitation) =>
      invitation.status === "pending" || invitation.status === "expired",
  );

  useEffect(() => {
    if (!open) return;
    setRole("member");
    setNotice(null);
    setError(null);
  }, [open]);

  async function invite(email: string) {
    setError(null);
    setNotice(null);
    try {
      await createOrgInvitation(org.id, email, role);
      setNotice(t("convite.enviado", { email }));
      await onChanged();
      return true;
    } catch (err) {
      setError(friendlyError(err, t("convite.erroEnviar")));
      return false;
    }
  }

  async function runInvitationAction(
    invitation: OrgInvitation,
    action: "resend" | "cancel",
  ) {
    setBusyId(invitation.id);
    setError(null);
    setNotice(null);
    try {
      if (action === "resend") {
        await resendOrgInvitation(org.id, invitation.id);
        setNotice(t("convite.reenviado", { email: invitation.email }));
      } else {
        await cancelOrgInvitation(org.id, invitation.id);
        setNotice(t("convite.cancelado", { email: invitation.email }));
      }
      await onChanged();
    } catch (err) {
      setError(
        friendlyError(
          err,
          action === "resend"
            ? t("convite.erroReenviar")
            : t("convite.erroCancelar"),
        ),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        breadcrumbs={[tg("organizacoes"), org.name, tg("adicionarMembro")]}
        size="md"
        footerStatus={
          notice ? (
            <span className="text-sm text-gray-400">{notice}</span>
          ) : null
        }
        cancelAction={false}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-5 py-1">
          <div>
            <FieldLabel htmlFor="organization-invite-role">
              {t("convite.papel")}
            </FieldLabel>
            <ModalSelect
              id="organization-invite-role"
              value={role}
              options={[
                { value: "admin", label: tg("papelAdmin") },
                { value: "member", label: tg("papelMembro") },
              ]}
              onChange={(value) => setRole(value as OrgRole)}
            />
            <p className="mt-2 text-xs text-gray-400">
              {tg(
                role === "admin"
                  ? "papelAdminDescricao"
                  : "papelMembroDescricao",
              )}
            </p>
          </div>

          <div>
            <FieldLabel as="p">{t("convite.enderecoEmail")}</FieldLabel>
            <AddUserInput
              autoFocus
              requireExistingUser={false}
              placeholder={t("convite.placeholderConvidar")}
              submitLabel={t("convite.enviarConvite")}
              onAdd={(user) => invite(user.email)}
            />
          </div>

          {pending.length > 0 ? (
            <div className="min-h-0 border-t border-white/60 pt-4">
              <p className="mb-2 text-xs font-medium text-gray-600">
                {t("convite.pendentes")}
              </p>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {pending.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-app-surface-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-gray-700">
                        {invitation.email}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {tg(PAPEL_KEYS[invitation.role])} ·{" "}
                        {invitation.status === "expired"
                          ? t("convite.expirado")
                          : t("convite.pendente")}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={t("convite.reenviarPara", {
                        email: invitation.email,
                      })}
                      disabled={busyId === invitation.id}
                      onClick={() =>
                        void runInvitationAction(invitation, "resend")
                      }
                      className="rounded-full p-1.5 text-gray-400 hover:bg-app-surface-active hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-40"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("convite.cancelarPara", {
                        email: invitation.email,
                      })}
                      disabled={busyId === invitation.id}
                      onClick={() =>
                        void runInvitationAction(invitation, "cancel")
                      }
                      className="rounded-full p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
      <WarningPopup
        open={open && error !== null}
        title={t("convite.erroTitulo")}
        message={error}
        onClose={() => setError(null)}
      />
    </>
  );
}

export function OrganizationSettingsModal({
  open,
  org,
  onClose,
  onUpdated,
  onDeleted,
}: {
  open: boolean;
  org: Org;
  onClose: () => void;
  onUpdated: (org: Org) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("organizations.modais");
  const tg = useTranslations("organizations.geral");
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const changed = useMemo(
    () => trimmedName !== org.name,
    [org.name, trimmedName],
  );

  useEffect(() => {
    if (!open) return;
    setName(org.name);
    setError(null);
    setConfirmDelete(false);
  }, [open, org.name]);

  async function save() {
    if (!trimmedName || !changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      onUpdated(await updateOrg(org.id, trimmedName));
    } catch (err) {
      setError(friendlyError(err, t("configuracoes.erroSalvar")));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteOrg(org.id);
      onDeleted();
    } catch (err) {
      setError(friendlyError(err, t("configuracoes.erroExcluir")));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        breadcrumbs={[tg("organizacoes"), org.name, t("configuracoes.titulo")]}
        size="md"
        primaryAction={{
          label: saving ? t("configuracoes.salvando") : t("configuracoes.salvar"),
          icon: saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : undefined,
          onClick: () => void save(),
          disabled: saving || !changed || !trimmedName,
        }}
      >
        <div className="flex flex-col gap-8 py-1">
          <div>
            <FieldLabel htmlFor="organization-settings-name">
              {t("configuracoes.nomeOrganizacao")}
            </FieldLabel>
            <FormTextInput
              id="organization-settings-name"
              value={name}
              disabled={saving || deleting}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </div>
          <div className="border-t border-white/60 pt-5">
            <p className="text-sm font-medium text-gray-700">
              {t("configuracoes.excluirTitulo")}
            </p>
            <p className="mt-1 max-w-md text-xs text-gray-400">
              {t("configuracoes.excluirDescricao")}
            </p>
            <PillButton
              tone="danger"
              size="sm"
              className="mt-3"
              disabled={deleting}
              loading={deleting}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("configuracoes.excluirTitulo")}
            </PillButton>
          </div>
        </div>
      </Modal>
      <ConfirmPopup
        open={confirmDelete}
        title={t("configuracoes.confirmarExclusao", { nome: org.name })}
        message={t("configuracoes.confirmarExclusaoMensagem")}
        confirmLabel={t("configuracoes.excluir")}
        confirmVariant="danger"
        confirmStatus={deleting ? "loading" : "idle"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
      <WarningPopup
        open={open && error !== null}
        title={t("configuracoes.naoSalvo")}
        message={error}
        onClose={() => setError(null)}
      />
    </>
  );
}
