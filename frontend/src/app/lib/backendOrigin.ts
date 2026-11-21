/**
 * The Express API's origin as this server reaches it. Read at call time, so
 * a published image honours the API_BASE_URL it is started with.
 */
export function backendOrigin() {
    const configuredUrl = process.env.API_BASE_URL?.trim();
    if (!configuredUrl && process.env.NODE_ENV === "production") {
        throw new Error("API_BASE_URL is required at runtime.");
    }

    const backendUrl = new URL(configuredUrl || "http://localhost:3001");
    if (!["http:", "https:"].includes(backendUrl.protocol)) {
        throw new Error("API_BASE_URL must use http or https.");
    }
    return backendUrl.toString().replace(/\/$/, "");
}
