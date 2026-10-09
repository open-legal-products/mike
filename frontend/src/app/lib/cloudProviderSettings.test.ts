import { describe, expect, it } from "vitest";
import {
  isVertexServiceAccountKey,
  normalizeAwsRegion,
  normalizeAzureEndpoint,
  normalizeAzureFoundryEndpoint,
  normalizeCustomBaseUrl,
  normalizeVertexLocation,
} from "./cloudProviderSettings";

describe("normalizeAwsRegion", () => {
  it("accepts region codes in any case", () => {
    expect(normalizeAwsRegion(" EU-West-2 ")).toBe("eu-west-2");
    expect(normalizeAwsRegion("us-gov-west-1")).toBe("us-gov-west-1");
  });

  it("rejects anything that is not a region code", () => {
    for (const value of ["", "us-east", "London", "us-east-1.example.com"]) {
      expect(normalizeAwsRegion(value)).toBeNull();
    }
  });
});

describe("normalizeAzureEndpoint", () => {
  it("accepts a resource name or an Azure AI endpoint", () => {
    expect(normalizeAzureEndpoint("Contoso-OpenAI")).toBe("contoso-openai");
    expect(
      normalizeAzureEndpoint("https://contoso.openai.azure.com/"),
    ).toBe("https://contoso.openai.azure.com");
    expect(
      normalizeAzureEndpoint(
        "https://contoso.services.ai.azure.com/api/projects/legal",
      ),
    ).toBe("https://contoso.services.ai.azure.com/api/projects/legal");
  });

  it("rejects non-Azure hosts, plain http and decorated URLs", () => {
    for (const value of [
      "https://example.com",
      "http://contoso.openai.azure.com",
      "https://contoso.openai.azure.com.example.com",
      "https://contoso.openai.azure.com/?key=1",
      "not a url",
      "   ",
      `https://contoso.openai.azure.com/${"a".repeat(300)}`,
    ]) {
      expect(normalizeAzureEndpoint(value)).toBeNull();
    }
  });
});

describe("normalizeAzureFoundryEndpoint", () => {
  it("turns a resource name or endpoint into the resource origin", () => {
    expect(normalizeAzureFoundryEndpoint("Contoso-Foundry")).toBe(
      "https://contoso-foundry.services.ai.azure.com",
    );
    expect(
      normalizeAzureFoundryEndpoint(
        "https://contoso.services.ai.azure.com/api/projects/legal",
      ),
    ).toBe("https://contoso.services.ai.azure.com");
  });

  it("rejects hosts outside Azure", () => {
    expect(normalizeAzureFoundryEndpoint("https://example.com")).toBeNull();
    expect(normalizeAzureFoundryEndpoint("")).toBeNull();
  });
});

describe("normalizeVertexLocation", () => {
  it("accepts regions and multi-regions in any case", () => {
    expect(normalizeVertexLocation(" US-Central1 ")).toBe("us-central1");
    expect(normalizeVertexLocation("global")).toBe("global");
    expect(normalizeVertexLocation("eu")).toBe("eu");
  });

  it("rejects anything that is not a single DNS label", () => {
    for (const value of ["", "us central1", "us-central1.example.com", "-us"]) {
      expect(normalizeVertexLocation(value)).toBeNull();
    }
  });
});

describe("normalizeCustomBaseUrl", () => {
  it("accepts a public https base URL and drops the trailing slash", () => {
    expect(normalizeCustomBaseUrl(" https://llm.example.com/v1/ ")).toBe(
      "https://llm.example.com/v1",
    );
    expect(normalizeCustomBaseUrl("https://llm.example.com:8443")).toBe(
      "https://llm.example.com:8443",
    );
  });

  it("rejects plain http, local hosts and decorated URLs", () => {
    for (const value of [
      "",
      "not a url",
      "http://llm.example.com/v1",
      "https://localhost/v1",
      "https://api.localhost/v1",
      "https://litellm/v1",
      "https://user:pass@llm.example.com/v1",
      "https://llm.example.com/v1?key=1",
      "https://llm.example.com/v1#models",
      `https://llm.example.com/${"a".repeat(300)}`,
    ]) {
      expect(normalizeCustomBaseUrl(value)).toBeNull();
    }
  });
});

describe("isVertexServiceAccountKey", () => {
  const key = {
    type: "service_account",
    project_id: "legal-prod",
    client_email: "mike@legal-prod.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
  };

  it("accepts a service-account key file", () => {
    expect(isVertexServiceAccountKey(JSON.stringify(key))).toBe(true);
  });

  it("rejects other JSON and plain API keys", () => {
    expect(isVertexServiceAccountKey("AIzaSy-not-json")).toBe(false);
    expect(isVertexServiceAccountKey("null")).toBe(false);
    expect(
      isVertexServiceAccountKey(
        JSON.stringify({ ...key, type: "authorized_user" }),
      ),
    ).toBe(false);
    expect(
      isVertexServiceAccountKey(JSON.stringify({ ...key, private_key: 1 })),
    ).toBe(false);
  });
});
