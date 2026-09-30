import { useState } from "react";
import { PresetTemplatesModal } from "./PresetTemplatesModal";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

// Run with: npm run catalog -- --stories src/app/components/library/PresetTemplatesModal.stories.tsx --viteConfig preset-preview.vite.config.mjs
// Browse and download real bundled files; importing requires the authenticated app.
export const BrowsePresets = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <PillButtonUI tone="white" onClick={() => setOpen(true)}>
        Browse presets
      </PillButtonUI>
      <PresetTemplatesModal
        open={open}
        onClose={() => setOpen(false)}
        folderId={null}
        onImported={() => {}}
      />
    </>
  );
};
