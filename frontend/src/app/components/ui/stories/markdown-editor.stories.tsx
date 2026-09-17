import { useState } from "react";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";

const meta = { title: "UI / MarkdownEditor" };
export default meta;

const SAMPLE_MARKDOWN = `# Matter summary

Review the **termination provisions** and note:

- notice periods
- payment obligations
- surviving clauses`;

export const Editable = () => {
    const [value, setValue] = useState(SAMPLE_MARKDOWN);

    return (
        <div className="h-[28rem] w-full max-w-[44rem]">
            <MarkdownEditor
                value={value}
                onChange={setValue}
                ariaLabel="Matter summary"
            />
        </div>
    );
};

export const ReadOnly = () => (
    <div className="h-[28rem] w-full max-w-[44rem]">
        <MarkdownEditor
            value={SAMPLE_MARKDOWN}
            readOnly
            ariaLabel="Matter summary"
        />
    </div>
);
