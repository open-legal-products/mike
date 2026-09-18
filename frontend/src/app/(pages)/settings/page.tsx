"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { deleteAccount, isMfaRequiredError } from "@/app/lib/mikeApi";
import { authMessages } from "@/app/lib/authMessages";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

interface EmailWarning {
  title: string;
  message: string;
}

/** Keyed by the `code` GoTrue returns from `PATCH /api/auth/email`. */
// One auth message source (authMessages.ts); only the email-field wording
// differs here, because a validation failure on this screen can only mean
// the address itself.
const EMAIL_ERROR_MESSAGES = authMessages({
  validation_failed: "Enter a valid email address.",
  invalid_request: "Enter a valid email address.",
  reauthentication_needed: "Log in again before changing your email.",
});

const EMAIL_TAKEN_CODES = new Set(["email_exists", "user_already_exists"]);
const EMAIL_RATE_LIMIT_CODES = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
]);

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, updateEmail } = useAuth();
  const { profile, updateDisplayName, updateOrganisation } = useUserProfile();
  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [saved, setSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [organisation, setOrganisation] = useState("");
  const [isSavingOrg, setIsSavingOrg] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<EmailWarning | null>(null);
  const [emailMfaOpen, setEmailMfaOpen] = useState(false);
  const [googleEmailModalOpen, setGoogleEmailModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [accountDeleteMfaOpen, setAccountDeleteMfaOpen] = useState(false);
  const requiresPasswordForEmailChange =
    user?.createdWithGoogle === true && profile?.passwordSet !== true;

  // Each field syncs from the profile independently. A combined effect
  // (both setters, keyed on both values) wiped in-progress text from the
  // sibling input whenever one field's blur-autosave refreshed the
  // profile; per-field effects don't run then, because the sibling's own
  // profile value did not change. Deliberately NO focused-input guard
  // here: skipping the sync while focused let a profile that loads after
  // mount leave the focused input empty, and blurring it then saved ""
  // over the stored name.
  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
  }, [profile?.displayName]);

  useEffect(() => {
    setOrganisation(profile?.organisation ?? "");
  }, [profile?.organisation]);

  useEffect(() => {
    if (user?.email) {
      setEmail(user.pendingEmail || user.email);
    }
  }, [user?.email, user?.pendingEmail]);

  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("emailChange") !==
        "processed" ||
      !user
    ) {
      return;
    }
    setEmailStatus(
      user.pendingEmail
        ? "One confirmation was accepted. Confirm the email change from both your current and new addresses to finish."
        : "Email updated.",
    );
    window.history.replaceState({}, "", "/settings");
  }, [user]);

  const handleDeleteAccount = async () => {
    devLog("[account/mfa] delete account requested");
    setIsDeleting(true);
    try {
      if (await needsMfaVerification()) {
        setDeleteConfirm(false);
        setAccountDeleteMfaOpen(true);
        setIsDeleting(false);
        return;
      }
      await deleteAccount();
      await signOut();
      router.push("/");
    } catch (error) {
      setIsDeleting(false);
      devLog("[account/mfa] delete account failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setDeleteConfirm(false);
        setAccountDeleteMfaOpen(true);
        return;
      }
      setDeleteConfirm(false);
      notifyError(error, {
        action: "delete your account",
        // Retry re-opens the confirmation instead of deleting outright: a
        // button in a toast must never be the only thing between a stray
        // click and an irreversible account deletion.
        onRetry: () => setDeleteConfirm(true),
        supportNote: "Account deletion failed.",
      });
    }
  };

  const handleSaveEmail = async () => {
    if (requiresPasswordForEmailChange) {
      setGoogleEmailModalOpen(true);
      return;
    }
    const nextEmail = email.trim();
    if (!nextEmail || nextEmail === user?.email) return;

    devLog("[account/mfa] save email requested");
    setIsSavingEmail(true);
    setEmailStatus(null);
    setEmailWarning(null);
    try {
      if (await needsMfaVerification()) {
        setEmailMfaOpen(true);
        return;
      }

      const updatedUser = await updateEmail(nextEmail);
      const pendingEmail = updatedUser.pendingEmail;
      setEmail(pendingEmail || updatedUser.email);
      setEmailSaved(true);
      setEmailStatus(
        pendingEmail
          ? `Confirmation sent to your current address and ${pendingEmail}. Confirm both messages to finish the change. Your current email remains ${updatedUser.email} until then.`
          : "Email updated.",
      );
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (error: unknown) {
      devLog("[account/mfa] save email failed", { error });
      // The backend passes GoTrue's `code` through, so the outcome is decided
      // by that code rather than by matching English in the message.
      const described = describeError(error, {
        action: "update your email",
        codeMessages: EMAIL_ERROR_MESSAGES,
        fallback: "Unable to update your email. Try again.",
      });

      if (described.code && EMAIL_TAKEN_CODES.has(described.code)) {
        setEmail(user?.pendingEmail || user?.email || "");
        setEmailWarning({
          title: "Email already registered",
          message: "An account with this email already exists.",
        });
        return;
      }

      if (
        (described.code && EMAIL_RATE_LIMIT_CODES.has(described.code)) ||
        described.kind === "rate_limited"
      ) {
        setEmail(user?.pendingEmail || user?.email || "");
        setEmailWarning({
          title: "Email change unavailable",
          message:
            "You can’t change your email this often. Wait a few minutes before trying again.",
        });
        return;
      }

      setEmailStatus(described.message);
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleSaveDisplayName = async () => {
    const nextName = displayName.trim();
    if (nextName === (profile?.displayName ?? "")) return;
    setIsSavingName(true);
    setNameError(null);
    const success = await updateDisplayName(nextName);
    setIsSavingName(false);

    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      // The profile context classified the failure and raised the toast
      // (message, Retry, support). This line is only the field's status, so
      // the user never reads two different explanations of one failure.
      setNameError("Not saved");
    }
  };

  const handleSaveOrganisation = async () => {
    const nextOrganisation = organisation.trim();
    if (nextOrganisation === (profile?.organisation ?? "")) return;
    setIsSavingOrg(true);
    setOrgError(null);
    const success = await updateOrganisation(nextOrganisation);
    setIsSavingOrg(false);

    if (success) {
      setOrgSaved(true);
      setTimeout(() => setOrgSaved(false), 2000);
    } else {
      setOrgError("Not saved");
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-8">
      {/* Profile Settings */}
      <section className="space-y-3">
        <SettingsHeading>Profile</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <div>
              <div className="flex items-start justify-between gap-3">
                <FieldLabel htmlFor="display-name">Display Name</FieldLabel>
                <span
                  className={`text-xs ${nameError ? "text-red-600" : "text-gray-400"}`}
                  aria-live="polite"
                >
                  {isSavingName
                    ? "Saving..."
                    : nameError
                      ? nameError
                      : saved
                        ? "Saved"
                        : ""}
                </span>
              </div>
              <SettingsTextInput
                id="display-name"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setNameError(null);
                  setSaved(false);
                }}
                onBlur={() => void handleSaveDisplayName()}
                placeholder="Enter your name"
              />
            </div>
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div>
              <div className="flex items-start justify-between gap-3">
                <FieldLabel htmlFor="organisation">Organisation</FieldLabel>
                <span
                  className={`text-xs ${orgError ? "text-red-600" : "text-gray-400"}`}
                  aria-live="polite"
                >
                  {isSavingOrg
                    ? "Saving..."
                    : orgError
                      ? orgError
                      : orgSaved
                        ? "Saved"
                        : ""}
                </span>
              </div>
              <SettingsTextInput
                id="organisation"
                type="text"
                value={organisation}
                onChange={(e) => {
                  setOrganisation(e.target.value);
                  setOrgError(null);
                  setOrgSaved(false);
                }}
                onBlur={() => void handleSaveOrganisation()}
                placeholder="Enter your organisation"
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </section>

      {/* Email */}
      <section className="space-y-3">
        <SettingsHeading>Email</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <div className="space-y-2">
              <SettingsTextInput
                aria-label="Email address"
                type="email"
                value={email}
                disabled={requiresPasswordForEmailChange}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailStatus(null);
                  setEmailWarning(null);
                  setEmailSaved(false);
                }}
                placeholder="Enter your email"
              />
              {emailStatus ? (
                <p className="text-xs text-gray-500">{emailStatus}</p>
              ) : user.pendingEmail ? (
                <p className="text-xs text-gray-500">
                  Pending confirmation: {user.pendingEmail}
                </p>
              ) : null}
              {emailStatus && (
                <p className="text-xs text-gray-400">
                  Current email: {user.email}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveEmail}
                  disabled={
                    isSavingEmail ||
                    (!requiresPasswordForEmailChange &&
                      (!email.trim() ||
                        email.trim() === user.email ||
                        email.trim() === user.pendingEmail ||
                        emailSaved))
                  }
                  className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                  {requiresPasswordForEmailChange
                    ? "Update"
                    : isSavingEmail
                      ? "Saving..."
                      : emailSaved
                        ? "Saved"
                        : "Save"}
                </button>
              </div>
            </div>
          </SettingsRow>
        </SettingsCard>
      </section>

      {/* Plan */}
      <section className="space-y-3">
        <SettingsHeading>Usage Plan</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <p className="text-base font-medium text-gray-500 capitalize">
              {profile?.tier || "Free"}
            </p>
          </SettingsRow>
        </SettingsCard>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <SettingsHeading tone="danger">Danger Zone</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Delete account</SettingsLabel>
              <SettingsDescription>
                Permanently delete your account and all associated data. This
                action cannot be undone.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setDeleteConfirm(true)}
              disabled={isDeleting}
              loading={isDeleting}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete account
            </PillButtonUI>
          </SettingsRow>
        </SettingsCard>
      </section>
      <ConfirmPopup
        open={deleteConfirm}
        title="Delete account?"
        message="This will permanently delete your account and all associated data. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={isDeleting ? "loading" : "idle"}
        cancelLabel="Cancel"
        onCancel={() => {
          if (isDeleting) return;
          setDeleteConfirm(false);
        }}
        onConfirm={() => void handleDeleteAccount()}
      />
      <WarningPopup
        open={!!emailWarning}
        title={emailWarning?.title}
        message={emailWarning?.message}
        onClose={() => setEmailWarning(null)}
      />
      <Modal
        open={googleEmailModalOpen}
        onClose={() => setGoogleEmailModalOpen(false)}
        breadcrumbs={["Account", "Change email"]}
        size="sm"
        className="h-auto"
        primaryAction={{
          label: "Go to Security",
          onClick: () => {
            setGoogleEmailModalOpen(false);
            router.push("/settings/security");
          },
        }}
      >
        <p className="pb-5 text-sm leading-relaxed text-gray-600">
          Your account was created with Google. To change your email, first add
          a password in Settings &gt; Security &gt; Password.
        </p>
      </Modal>
      <MfaVerificationPopup
        open={accountDeleteMfaOpen}
        onCancel={() => setAccountDeleteMfaOpen(false)}
        onVerified={() => {
          devLog("[account/mfa] account delete verification callback");
          setAccountDeleteMfaOpen(false);
          void handleDeleteAccount();
        }}
        title="Two-factor verification required"
        message="Account deletion is sensitive. Enter a code from your authenticator app to continue."
      />
      <MfaVerificationPopup
        open={emailMfaOpen}
        onCancel={() => setEmailMfaOpen(false)}
        onVerified={() => {
          devLog("[account/mfa] email verification callback");
          setEmailMfaOpen(false);
          void handleSaveEmail();
        }}
        title="Two-factor verification required"
        message="Email changes are sensitive. Enter a code from your authenticator app to continue."
      />
    </div>
  );
}
