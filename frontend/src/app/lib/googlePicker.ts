/**
 * Google Picker: Google's own Drive file chooser, shown as an overlay on the
 * page. Picking a file there is what grants Mike's drive.file connection
 * access to it, so this is the only way an existing Drive file becomes
 * readable by the assistant.
 *
 * The Picker ships as part of Google's browser API loader (gapi), not as an
 * npm package, so the script is added on first use and cached.
 */

const GOOGLE_API_SCRIPT = "https://apis.google.com/js/api.js";

/** One picked file, as Google describes it. */
export type PickedDriveFile = { id: string; name: string; mimeType: string };

type PickerDocument = Record<string, string>;
type PickerResponse = Record<string, unknown>;

type DocsView = {
    setIncludeFolders(include: boolean): DocsView;
    setSelectFolderEnabled(enabled: boolean): DocsView;
};

type PickerBuilder = {
    setOAuthToken(token: string): PickerBuilder;
    setDeveloperKey(key: string): PickerBuilder;
    setAppId(appId: string): PickerBuilder;
    enableFeature(feature: string): PickerBuilder;
    addView(view: DocsView): PickerBuilder;
    setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
    build(): { setVisible(visible: boolean): void };
};

/** The slice of google.picker this module uses. */
export type GooglePickerApi = {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: string) => DocsView;
    ViewId: { DOCS: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
    Action: { PICKED: string; CANCEL: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string; MIME_TYPE: string };
};

declare global {
    interface Window {
        gapi?: {
            load(
                api: string,
                options: { callback: () => void; onerror: () => void },
            ): void;
        };
        google?: { picker?: GooglePickerApi };
    }
}

let pickerApi: Promise<GooglePickerApi> | null = null;

function loadGoogleApiScript(): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = GOOGLE_API_SCRIPT;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () =>
            reject(new Error("The Google API script could not be loaded."));
        document.head.appendChild(script);
    });
}

/** Loads gapi and its picker module once; a failed load can be retried. */
export function loadGooglePicker(): Promise<GooglePickerApi> {
    pickerApi ??= (async () => {
        if (!window.gapi) await loadGoogleApiScript();
        await new Promise<void>((resolve, reject) =>
            window.gapi!.load("picker", {
                callback: resolve,
                onerror: () =>
                    reject(new Error("The Google Picker could not be loaded.")),
            }),
        );
        const api = window.google?.picker;
        if (!api) throw new Error("The Google Picker could not be loaded.");
        return api;
    })().catch((error: unknown) => {
        pickerApi = null;
        throw error;
    });
    return pickerApi;
}

/**
 * Shows the Picker over the page. Resolves with the picked files, or an empty
 * list when the user closes it. Folders are browsable but not selectable:
 * picking a folder would not grant drive.file access to the files inside it.
 */
export async function openGoogleDrivePicker({
    accessToken,
    developerKey,
    appId,
}: {
    accessToken: string;
    developerKey: string;
    appId: string;
}): Promise<PickedDriveFile[]> {
    const picker = await loadGooglePicker();
    return new Promise((resolve) => {
        const view = new picker.DocsView(picker.ViewId.DOCS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(false);
        new picker.PickerBuilder()
            .setOAuthToken(accessToken)
            .setDeveloperKey(developerKey)
            .setAppId(appId)
            .enableFeature(picker.Feature.MULTISELECT_ENABLED)
            .enableFeature(picker.Feature.SUPPORT_DRIVES)
            .addView(view)
            .setCallback((response) => {
                const action = response[picker.Response.ACTION];
                if (action === picker.Action.CANCEL) resolve([]);
                if (action !== picker.Action.PICKED) return;
                const docs = (response[picker.Response.DOCUMENTS] ??
                    []) as PickerDocument[];
                resolve(
                    docs.map((doc) => ({
                        id: doc[picker.Document.ID],
                        name: doc[picker.Document.NAME],
                        mimeType: doc[picker.Document.MIME_TYPE],
                    })),
                );
            })
            .build()
            .setVisible(true);
    });
}
