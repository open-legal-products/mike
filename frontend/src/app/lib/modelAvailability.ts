// The web app's view of key-based model availability. The rules live in the
// catalog shared with the Word add-in (@/shared/lib/modelCatalog); the web
// app's ApiKeyState is a ProviderKeyStates.
export {
    getModelProvider,
    isModelAvailable,
    isProviderAvailable,
    modelGroupToProvider,
    providerLabel,
    type ModelProvider,
} from "@/shared/lib/modelCatalog";
