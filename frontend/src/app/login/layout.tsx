import { SignInProviderHintProvider } from "@/app/contexts/SignInProviderHintContext";
import { readSignInProviderHint } from "@/app/lib/signInProviderHint";

// Re-rendered in the background at most once a minute, so the page stays a
// cached static response while its provider buttons follow the deployment.
// Must be a literal; keep in step with SIGN_IN_PROVIDER_HINT_TTL_SECONDS.
export const revalidate = 60;

export default async function LoginLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <SignInProviderHintProvider hint={await readSignInProviderHint()}>
            {children}
        </SignInProviderHintProvider>
    );
}
