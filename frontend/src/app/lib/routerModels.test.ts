import { describe, expect, it } from "vitest";
import {
    ROUTER_PROFILE_FIELDS,
    ROUTER_SLUGS,
    routerModelsFromProfile,
} from "./routerModels";

describe("routerModelsFromProfile", () => {
    it("reads every router's selection from its profile field", () => {
        const selections = routerModelsFromProfile({
            openRouterModels: ["openai/gpt-5.4"],
            azureFoundryModels: ["claude-opus-5-5"],
            xaiModels: ["grok-4.3"],
        });
        expect(selections.openrouter).toEqual(["openai/gpt-5.4"]);
        expect(selections["azure-foundry"]).toEqual(["claude-opus-5-5"]);
        expect(selections.xai).toEqual(["grok-4.3"]);
        expect(Object.keys(selections)).toEqual([...ROUTER_SLUGS]);
    });

    it("gives every router an empty list when the profile is missing or partial", () => {
        for (const profile of [null, undefined, {}, { vertexModels: null }]) {
            const selections = routerModelsFromProfile(profile);
            for (const slug of ROUTER_SLUGS) {
                expect(selections[slug]).toEqual([]);
            }
        }
    });

    it("names one distinct profile field per router", () => {
        const fields = ROUTER_SLUGS.map((slug) => ROUTER_PROFILE_FIELDS[slug]);
        expect(new Set(fields).size).toBe(ROUTER_SLUGS.length);
    });
});
