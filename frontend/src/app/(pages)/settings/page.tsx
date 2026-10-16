"use client";

import { ProfilePhotoSettings } from "@/app/components/settings/ProfilePhotoSettings";
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
import {
  describeError,
  notifyError,
} from "@/app/lib/userFacingError";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
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

/** Composes authenticated account settings, including profile-photo editing and account security controls. */
export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, updateEmail } = useAuth();
  const { profile, updateDisplayName } = useUserProfile();
  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [saved, setSaved] = useState(false);
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

  // Sync a profile that loads after mount, even while the name input is focused.
  // Otherwise an empty blur-autosave could overwrite the stored name.
  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
  }, [profile?.displayName]);

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
        // button in a notice must never be the only thing between a stray
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
    const success = await updateDisplayName(nextName);
    setIsSavingName(false);

    // A failure is reported once, by the profile context's notice (message,
    // Retry, support); the field shows no second status for it.
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-8">
      {/* Profile Settings */}
      <section className="space-y-3">
        <SettingsHeading>Profile</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div>
              <div className="flex items-start justify-between gap-3">
                <FieldLabel htmlFor="display-name">Display Name</FieldLabel>
                <span
                  className="text-xs text-gray-400"
                  aria-live="polite"
                >
                  {isSavingName
                    ? "Saving..."
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
                  setSaved(false);
                }}
                onBlur={() => void handleSaveDisplayName()}
                placeholder="Enter your name"
              />
            </div>
          </SettingsRow>
          <ProfilePhotoSettings />
        </GlassCardUI>
      </section>

      {/* Email */}
      <section className="space-y-3">
        <SettingsHeading>Email</SettingsHeading>
        <GlassCardUI>
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
        </GlassCardUI>
      </section>

      {/* Plan */}
      <section className="space-y-3">
        <SettingsHeading>Usage Plan</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <p className="text-base font-medium text-gray-500 capitalize">
              {profile?.tier || "Free"}
            </p>
          </SettingsRow>
        </GlassCardUI>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <SettingsHeading tone="danger">Danger Zone</SettingsHeading>
        <GlassCardUI>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Delete account</SettingsLabel>
              <SettingsDescription>
                Permanently delete your account and personal workspace. Organization work follows the member removal policy.
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
        </GlassCardUI>
      </section>
      <ConfirmPopup
        open={deleteConfirm}
        title="Delete account?"
        message="This permanently deletes your account and personal workspace. In each organization, shared work without another owner transfers to a remaining organization owner. Unshared private work is retained for 30 days for organization owners to recover or delete. You must appoint another owner or delete any organization you solely own first."
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
