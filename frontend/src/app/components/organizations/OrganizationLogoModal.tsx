"use client";

import { ImageCropModal } from "@/app/components/modals/ImageCropModal";

/** Adapts the shared crop modal to organization-logo naming and its square framing variant. */
export function OrganizationLogoModal({ organizationName, ...props }: {
  file?: File;
  imageUrl?: string | null;
  organizationName: string;
  saving?: boolean;
  removing?: boolean;
  onRemove?: () => void;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  return <ImageCropModal {...props} name={organizationName} />;
}
