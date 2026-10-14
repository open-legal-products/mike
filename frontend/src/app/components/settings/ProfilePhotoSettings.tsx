"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ImageCropModal } from "@/app/components/modals/ImageCropModal";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ORG_LOGO_ACCEPT, OrgLogoImageError, validateOrgLogoFile } from "@/app/lib/orgLogoImage";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";

/** Lets the current user choose, crop, replace, or remove a profile photo and displays recoverable save errors. */
export function ProfilePhotoSettings() {
  const { user } = useAuth();
  const { profile, loading, updateProfilePhoto } = useUserProfile();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Persists a photo or removal once at a time, closing the crop modal only after a successful update. */
  async function save(photo: string | null) {
    if (saving) return;
    setSaving(photo === null ? "remove" : "save");
    setError(null);
    try {
      await updateProfilePhoto(photo);
      setFile(null);
      setEditing(false);
    } catch (cause) {
      setError(userFacingApiError(cause, "Could not save your profile photo. Try again."));
    } finally {
      setSaving(null);
    }
  }

  return (
    <SettingsRow>
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar photo={profile?.profilePhoto} name={profile?.displayName} email={user?.email} className="h-11 w-11 text-base" />
        <div className="min-w-0 space-y-1">
          <SettingsLabel>Profile photo</SettingsLabel>
          <SettingsDescription>Shown beside your name when you share or work with others.</SettingsDescription>
          {error && !editing ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <input ref={input} type="file" accept={ORG_LOGO_ACCEPT} className="hidden" aria-label="Upload profile photo" onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (!picked) return;
          setError(null);
          try {
            validateOrgLogoFile(picked);
            setFile(picked);
            setEditing(true);
          } catch (cause) {
            setError(cause instanceof OrgLogoImageError ? cause.message : "Choose another image.");
          }
        }} />
        <PillButtonUI size="sm" tone={profile?.profilePhoto ? "blue" : "white"} disabled={loading || saving !== null} onClick={() => {
          setError(null);
          if (profile?.profilePhoto) setEditing(true);
          else input.current?.click();
        }}>
          {profile?.profilePhoto ? "Edit" : "Upload photo"}
        </PillButtonUI>
      </div>
      {editing ? <ImageCropModal
        file={file ?? undefined}
        imageUrl={profile?.profilePhoto}
        name={profile?.displayName || user?.email || "You"}
        variant="photo"
        saving={saving === "save"}
        removing={saving === "remove"}
        error={error}
        onCancel={() => { setEditing(false); setFile(null); setError(null); }}
        onSave={(photo) => void save(photo)}
        onRemove={profile?.profilePhoto ? () => void save(null) : undefined}
      /> : null}
    </SettingsRow>
  );
}
