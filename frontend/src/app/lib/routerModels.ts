// Compatibility adapter for web callers; both clients use the shared catalog.
import { routerSelections, type RouterSelections, type RouterProfileField } from "@/shared/lib/modelCatalog";
export { ROUTER_SLUGS, ROUTER_PROFILE_FIELDS, type RouterSlug, type RouterProfileField } from "@/shared/lib/modelCatalog";
export type RouterModelSelections = Partial<RouterSelections>;
export function routerModelsFromProfile(
    profile: Partial<Record<RouterProfileField, string[] | null | undefined>> | null | undefined,
): RouterSelections {
    return routerSelections(profile ?? {});
}
