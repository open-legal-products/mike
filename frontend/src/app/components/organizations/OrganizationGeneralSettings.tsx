"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Trash2, Upload } from "lucide-react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MemberDepartureDialog,
  type MemberDepartureResult,
} from "./MemberDepartureDialog";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { FieldLabel } from "@/app/components/ui/form-field";
import { useAuth } from "@/app/contexts/AuthContext";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useOrganizationLogo } from "@/app/hooks/useOrganizationLogo";
import {
  deleteOrg,
  deleteOrgLogo,
  isMfaRequiredError,
  saveOrgLogo,
  updateOrg,
} from "@/app/lib/mikeApi";
import {
  ORG_LOGO_ACCEPT,
  OrgLogoImageError,
  validateOrgLogoFile,
} from "@/app/lib/orgLogoImage";
import {
  ORG_ROLE_LABELS,
  isOrgAdmin,
  isOrgOwner,
} from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { MikeIcon } from "@/shared/ui/MikeIconUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { OrganizationLogoModal } from "./OrganizationLogoModal";
import { useOrganizationSettings } from "./OrganizationSettingsShell";

// The General section of an organization's settings. Everyone in the
// organization sees it: its name, their own role and the way out. Renaming
// is its owners' and admins', deleting it its owners' alone; the server
// refuses both for anyone else, so those controls are simply not drawn.

/** Where somebody lands once the organization is no longer theirs to see. */
const AFTER_DEPARTURE = "/settings/organizations";

type Pending = "leave" | "delete";

export function OrganizationGeneralSettings() {
  const router = useRouter();
  const { user } = useAuth();
  const { refreshOrganizations } = useWorkspace();
  const { org, setOrg } = useOrganizationSettings();
  const [nameStatus, setNameStatus] = useState<
    "idle" | "saving" | "saved" | { error: string }
  >("idle");
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState<Pending | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // The saved name arrives with the organization, after mount, and changes
  // when a save lands; the field follows it whenever it does.
  const savedName = org?.name ?? "";
  const [draft, setDraft] = useState({ saved: savedName, value: savedName });
  if (draft.saved !== savedName)
    setDraft({ saved: savedName, value: savedName });
  const name = draft.value;
  const setName = (value: string) =>
    setDraft((current) => ({ ...current, value }));

  // The logo row: what is shown now, and the two things that change it.
  const logo = useOrganizationLogo(org);
  const hasLogo = !!org?.logo_updated_at;
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState<"upload" | "remove" | null>(null);

  // A picked image waits here while it is framed in the logo dialog.
  const [logoEditing, setLogoEditing] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);

  function pickLogo(file: File) {
    try {
      // Type and size, before anything is opened.
      validateOrgLogoFile(file);
    } catch (error) {
      setFailure({
        title: "Logo not updated",
        message:
          error instanceof OrgLogoImageError
            ? error.message
            : "That image cannot be used.",
      });
      return;
    }
    setLogoFile(file);
    setLogoEditing(true);
  }

  async function saveLogo(dataUrl: string) {
    if (!org || logoBusy) return;
    setLogoBusy("upload");
    try {
      const saved = await saveOrgLogo(org.id, dataUrl);
      setOrg({ ...org, logo_updated_at: saved.logo_updated_at });
      // The sidebar shows it too.
      void refreshOrganizations();
      setLogoFile(null);
      setLogoEditing(false);
    } catch (error) {
      // The dialog stays up, with the framing intact, to try again.
      setFailure({
        title: "Logo not updated",
        message: userFacingApiError(error, "The logo could not be saved."),
      });
    } finally {
      setLogoBusy(null);
    }
  }

  async function removeLogo() {
    if (!org || logoBusy) return;
    setLogoBusy("remove");
    try {
      await deleteOrgLogo(org.id);
      setLogoFile(null);
      setLogoEditing(false);
      setOrg({ ...org, logo_updated_at: null });
      void refreshOrganizations();
    } catch (error) {
      setFailure({
        title: "Logo not removed",
        message: userFacingApiError(error, "The logo could not be removed."),
      });
    } finally {
      setLogoBusy(null);
    }
  }

  const canRename = !!org && isOrgAdmin(org.role);
  const canDelete = !!org && isOrgOwner(org.role);
  const trimmedName = name.trim();

  async function saveName() {
    if (!org || !canRename || nameStatus === "saving") return;
    if (!trimmedName) {
      // An empty name is not a rename; put the saved one back.
      setName(org.name);
      setNameStatus("idle");
      return;
    }
    if (trimmedName === org.name) return;
    setNameStatus("saving");
    try {
      const updated = await updateOrg(org.id, trimmedName);
      setOrg({ ...updated, member_count: org.member_count });
      setNameStatus("saved");
      // The sidebar and the workspace switcher show the name too.
      void refreshOrganizations();
    } catch (error) {
      setNameStatus({
        error: userFacingApiError(error, "Could not rename the organization."),
      });
    }
  }

  // Leaving goes through its own dialog, which also settles who takes over
  // what the member alone owns; this is what the page does once it is done.
  function finishLeave(result: MemberDepartureResult) {
    setPending(null);
    if (!user?.id || !result.removedUserIds.includes(user.id)) {
      setFailure({
        title: "Could not leave the organization",
        message: userFacingApiError(
          result.error,
          "You could not be removed from the organization.",
        ),
      });
      return;
    }
    // `working` stays set: the button must not fire a second time while the
    // page navigates away from an organization that is gone.
    setWorking("leave");
    void refreshOrganizations();
    router.push(AFTER_DEPARTURE);
  }

  async function confirm(action: Pending | null = pending) {
    if (!org || action !== "delete" || working) return;
    setWorking(action);
    try {
      // Deleting an organization destroys everything in it, so it asks
      // for a second factor like the other destructive data actions.
      if (await needsMfaVerification()) {
        setPending(null);
        setWorking(null);
        setMfaPending(true);
        return;
      }
      await deleteOrg(org.id);
    } catch (error) {
      setPending(null);
      setWorking(null);
      if (isMfaRequiredError(error)) {
        setMfaPending(true);
        return;
      }
      setFailure({
        title: "Organization not deleted",
        message: userFacingApiError(
          error,
          "Could not delete the organization.",
        ),
      });
      return;
    }
    // `working` stays set: the button must not fire a second time while the
    // page navigates away from an organization that is gone.
    setPending(null);
    void refreshOrganizations();
    router.push(AFTER_DEPARTURE);
  }

  const statusText =
    nameStatus === "saving"
      ? "Saving..."
      : nameStatus === "saved"
        ? "Saved"
        : typeof nameStatus === "object"
          ? nameStatus.error
          : "";

  return (
    <div className="space-y-8">
      <section aria-labelledby="org-general-details" className="space-y-3">
        <SettingsHeading id="org-general-details">General</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            {!org ? (
              <div className="space-y-2">
                <span className="block h-4 w-36 animate-pulse rounded bg-gray-200" />
                <span className="block h-10 w-full animate-pulse rounded-lg bg-gray-200" />
              </div>
            ) : canRename ? (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <FieldLabel htmlFor="organization-name">
                    Organization name
                  </FieldLabel>
                  <span
                    className={`text-xs ${typeof nameStatus === "object" ? "text-red-600" : "text-gray-400"}`}
                    aria-live="polite"
                  >
                    {statusText}
                  </span>
                </div>
                <SettingsTextInput
                  id="organization-name"
                  type="text"
                  value={name}
                  disabled={nameStatus === "saving"}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameStatus("idle");
                  }}
                  onBlur={() => void saveName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveName();
                    }
                  }}
                />
              </div>
            ) : (
              <div className="space-y-1">
                <SettingsLabel>Organization name</SettingsLabel>
                <p className="text-sm break-words text-gray-500">{org.name}</p>
              </div>
            )}
          </SettingsRow>
          {/* The organization's own mark, for the people who run it to set.
              A member has nothing to do here, so the row is theirs to not
              see; they meet the logo in the sidebar. */}
          {canRename ? (
            <SettingsRow>
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a small inline data URL, not an optimizable remote image
                    <img
                      src={logo}
                      alt="Current logo"
                      className="h-8 w-8 rounded-[5px] object-contain"
                    />
                  ) : logo === undefined ? (
                    <span className="h-8 w-8 animate-pulse rounded bg-gray-200" />
                  ) : (
                    <MikeIcon size={20} />
                  )}
                </span>
                <div className="min-w-0 space-y-1">
                  <SettingsLabel>Logo</SettingsLabel>
                  <SettingsDescription>
                    Shown at the top of the sidebar. PNG, JPEG or WebP.
                  </SettingsDescription>
                </div>
              </div>
              <div className="flex w-full shrink-0 gap-2 sm:w-auto">
                <PillButtonUI
                  tone="blue"
                  size="sm"
                  disabled={logoBusy !== null}
                  loading={logoBusy === "upload"}
                  aria-label={hasLogo ? "Edit logo" : "Upload logo"}
                  onClick={() => {
                    if (hasLogo) setLogoEditing(true);
                    else logoInputRef.current?.click();
                  }}
                >
                  {!hasLogo && <Upload aria-hidden className="h-4 w-4 shrink-0" />}
                  {hasLogo ? "Edit" : "Upload"}
                </PillButtonUI>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept={ORG_LOGO_ACCEPT}
                  aria-label="Logo image"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Cleared so that picking the same file again, after a
                    // failure, is still a change.
                    event.target.value = "";
                    if (file) pickLogo(file);
                  }}
                />
              </div>
            </SettingsRow>
          ) : null}
        </GlassCardUI>
      </section>

      <section aria-labelledby="org-general-membership" className="space-y-3">
        <SettingsHeading id="org-general-membership">
          Your Membership
        </SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Your role</SettingsLabel>
              {org ? (
                <p className="text-sm text-gray-500">
                  {ORG_ROLE_LABELS[org.role]}
                </p>
              ) : (
                <span className="block h-5 w-20 animate-pulse rounded bg-gray-200" />
              )}
            </div>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Leave organization</SettingsLabel>
              <SettingsDescription>
                You will lose access to everything shared with you in this
                organization.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              disabled={!org || working !== null}
              loading={working === "leave"}
              onClick={() => setPending("leave")}
              className="w-full shrink-0 sm:w-auto"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Leave
            </PillButtonUI>
          </SettingsRow>
        </GlassCardUI>
      </section>

      {canDelete ? (
        <section aria-labelledby="org-general-delete" className="space-y-3">
          <SettingsHeading id="org-general-delete" tone="danger">
            Delete Organization
          </SettingsHeading>
          <GlassCardUI>
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>Delete this organization</SettingsLabel>
                <SettingsDescription>
                  Remove access for all members. Owners can restore the
                  organization for 30 days before its content is permanently deleted.
                </SettingsDescription>
              </div>
              <PillButtonUI
                tone="danger"
                size="sm"
                disabled={working !== null}
                loading={working === "delete"}
                onClick={() => setPending("delete")}
                className="w-full shrink-0 sm:w-auto"
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                Delete
              </PillButtonUI>
            </SettingsRow>
          </GlassCardUI>
        </section>
      ) : null}

      {logoEditing && org ? (
        <OrganizationLogoModal
          file={logoFile ?? undefined}
          imageUrl={logo}
          organizationName={org.name}
          saving={logoBusy === "upload"}
          removing={logoBusy === "remove"}
          onRemove={hasLogo ? () => void removeLogo() : undefined}
          onCancel={() => { setLogoFile(null); setLogoEditing(false); }}
          onSave={(dataUrl) => void saveLogo(dataUrl)}
        />
      ) : null}
      {pending === "leave" && org && user?.id ? (
        <MemberDepartureDialog
          orgId={org.id}
          departing={[{ user_id: user.id, email: user.email ?? null }]}
          leaving
          onCancel={() => setPending(null)}
          onDone={finishLeave}
        />
      ) : null}
      <ConfirmPopup
        open={pending === "delete"}
        title={`Delete ${org?.name ?? "this organization"}?`}
        message="This removes access to the organization for all members. Its content and memberships are kept for 30 days. An owner can restore it from Settings → Organizations during that period. After 30 days, it is permanently deleted."
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={working ? "loading" : "idle"}
        onCancel={() => {
          if (working) return;
          setPending(null);
        }}
        onConfirm={() => void confirm()}
      />
      <MfaVerificationPopup
        open={mfaPending}
        onCancel={() => setMfaPending(false)}
        onVerified={() => {
          setMfaPending(false);
          void confirm("delete");
        }}
        title="Two-factor verification required"
        message="This action is sensitive. Enter a code from your authenticator app to continue."
      />
      <WarningPopup
        open={failure !== null}
        title={failure?.title ?? "Organization not updated"}
        message={failure?.message ?? null}
        onClose={() => setFailure(null)}
      />
    </div>
  );
}
