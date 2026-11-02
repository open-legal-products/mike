import { describe, expect, it } from "vitest";
import {
  awsDnsSuffix,
  bedrockServiceUrl,
  azureClientTarget,
  azureFoundryCredentials,
  credentialEndpointHost,
  customEndpointCredentials,
  normalizeAwsRegion,
  normalizeAzureEndpoint,
  normalizeAzureFoundryEndpoint,
  normalizeCustomBaseUrl,
  normalizeVertexLocation,
  parseVertexServiceAccount,
  vertexCredentials,
} from "./cloudProviders";

describe("normalizeAwsRegion", () => {
  it.each([
    ["us-east-1", "us-east-1"],
    [" EU-Central-2 ", "eu-central-2"],
    ["us-gov-west-1", "us-gov-west-1"],
    ["ap-southeast-5", "ap-southeast-5"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeAwsRegion(input)).toBe(expected);
  });

  it.each(["", "us-east", "useast1", "us-east-1.evil.com", "us east 1", null, 1])(
    "rejects %j",
    (input) => {
      expect(normalizeAwsRegion(input)).toBeNull();
    },
  );
});

describe("normalizeAzureEndpoint", () => {
  it.each([
    ["Contoso-OpenAI", "contoso-openai"],
    [
      "https://contoso.openai.azure.com/",
      "https://contoso.openai.azure.com",
    ],
    [
      "https://contoso.openai.azure.com/openai/v1/",
      "https://contoso.openai.azure.com/openai/v1",
    ],
    [
      "https://contoso.cognitiveservices.azure.com",
      "https://contoso.cognitiveservices.azure.com",
    ],
    [
      "https://contoso.services.ai.azure.com/api/projects/legal",
      "https://contoso.services.ai.azure.com/api/projects/legal",
    ],
  ])("accepts %j", (input, expected) => {
    expect(normalizeAzureEndpoint(input)).toBe(expected);
  });

  it.each([
    "",
    "http://contoso.openai.azure.com",
    "https://attacker.example",
    "https://openai.azure.com",
    "https://contoso.openai.azure.com.attacker.example",
    "https://user:pass@contoso.openai.azure.com",
    "https://contoso.openai.azure.com:8443",
    "https://contoso.openai.azure.com/openai?x=1",
    "https://169.254.169.254/openai",
    "-leading-hyphen",
  ])("rejects %j", (input) => {
    expect(normalizeAzureEndpoint(input)).toBeNull();
  });
});

describe("azureClientTarget", () => {
  it("expands a resource name to the URL the SDK's resourceName option builds", () => {
    expect(azureClientTarget("contoso-openai")).toEqual({
      baseURL: "https://contoso-openai.openai.azure.com/openai",
    });
  });

  it("adds the /openai path to a bare host", () => {
    expect(azureClientTarget("https://contoso.cognitiveservices.azure.com")).toEqual({
      baseURL: "https://contoso.cognitiveservices.azure.com/openai",
    });
  });

  it("keeps an explicit path", () => {
    expect(
      azureClientTarget("https://contoso.services.ai.azure.com/api/projects/legal"),
    ).toEqual({
      baseURL: "https://contoso.services.ai.azure.com/api/projects/legal",
    });
  });
});

describe("credentialEndpointHost", () => {
  it.each([
    ["azure", { azure: { endpoint: "contoso-openai" } }, "contoso-openai.openai.azure.com"],
    [
      "azure-foundry",
      { "azure-foundry": { endpoint: "https://contoso.services.ai.azure.com" } },
      "contoso.services.ai.azure.com",
    ],
    ["custom", { custom: { baseUrl: "https://llm.example.com:8443/v1" } }, "llm.example.com:8443"],
    ["custom", {}, null],
  ] as const)("%s %j is sent to %j", (provider, settings, host) => {
    expect(credentialEndpointHost(provider, settings)).toBe(host);
  });

  it("puts a resource name and its full URL on the same host", () => {
    expect(
      credentialEndpointHost("azure", { azure: { endpoint: "contoso" } }),
    ).toBe(
      credentialEndpointHost("azure", {
        azure: { endpoint: "https://contoso.openai.azure.com" },
      }),
    );
  });
});

// A stand-in for a PEM key. The header is assembled so the file never holds a
// complete key block for secret scanners to match.
const FAKE_PRIVATE_KEY = `-----BEGIN ${"PRIVATE"} KEY-----\\nabc`;

describe("normalizeAzureFoundryEndpoint", () => {
  it.each([
    ["Contoso-Foundry", "https://contoso-foundry.services.ai.azure.com"],
    [
      "https://contoso.services.ai.azure.com/api/projects/legal",
      "https://contoso.services.ai.azure.com",
    ],
    [
      "https://contoso.openai.azure.com/openai/v1/",
      "https://contoso.openai.azure.com",
    ],
  ])("turns %j into the resource origin", (input, expected) => {
    expect(normalizeAzureFoundryEndpoint(input)).toBe(expected);
  });

  it.each([
    "",
    "https://attacker.example",
    "http://contoso.services.ai.azure.com",
    "https://services.ai.azure.com.attacker.example",
    null,
  ])("rejects %j", (input) => {
    expect(normalizeAzureFoundryEndpoint(input)).toBeNull();
  });
});

describe("normalizeVertexLocation", () => {
  it.each([
    [" US-Central1 ", "us-central1"],
    ["europe-west4", "europe-west4"],
    ["global", "global"],
    ["eu", "eu"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeVertexLocation(input)).toBe(expected);
  });

  // The location is interpolated into the API hostname.
  it.each(["", "us-central1.attacker.example", "us central1", "-us", "a/b", 7])(
    "rejects %j",
    (input) => {
      expect(normalizeVertexLocation(input)).toBeNull();
    },
  );
});

describe("parseVertexServiceAccount", () => {
  const file = {
    type: "service_account",
    project_id: "legal-prod",
    private_key_id: "key-1",
    private_key: FAKE_PRIVATE_KEY,
    client_email: "mike@legal-prod.iam.gserviceaccount.com",
    token_uri: "https://attacker.example/token",
    universe_domain: "attacker.example",
  };

  it("reads only the fields Mike uses", () => {
    expect(parseVertexServiceAccount(JSON.stringify(file))).toEqual({
      clientEmail: "mike@legal-prod.iam.gserviceaccount.com",
      privateKey: file.private_key,
      privateKeyId: "key-1",
      project: "legal-prod",
    });
  });

  it.each([
    ["an API key", "AIzaSy-plain-key"],
    ["a JSON array", "[]"],
    ["a user credential", JSON.stringify({ ...file, type: "authorized_user" })],
    [
      "an email outside gserviceaccount.com",
      JSON.stringify({ ...file, client_email: "mike@attacker.example" }),
    ],
    ["a missing private key", JSON.stringify({ ...file, private_key: "" })],
    [
      "a project id that would change the request path",
      JSON.stringify({ ...file, project_id: "legal-prod/../../other" }),
    ],
    ["an oversized value", JSON.stringify({ ...file, pad: "x".repeat(20_000) })],
    ["a non-string", 42],
  ])("rejects %s", (_label, value) => {
    expect(parseVertexServiceAccount(value)).toBeNull();
  });
});

describe("normalizeCustomBaseUrl", () => {
  it.each([
    [" https://llm.example.com/v1/ ", "https://llm.example.com/v1"],
    ["https://LLM.Example.com:8443", "https://llm.example.com:8443"],
    ["https://8.8.8.8/v1", "https://8.8.8.8/v1"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeCustomBaseUrl(input)).toBe(expected);
  });

  // The backend sends the user's key and request to this URL.
  it.each([
    "",
    "not a url",
    "http://llm.example.com/v1",
    "https://localhost/v1",
    "https://api.localhost/v1",
    "https://litellm/v1",
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://10.0.0.5:8000/v1",
    "https://192.168.1.10/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/v1",
    "https://[fd00::1]/v1",
    "https://[::ffff:10.0.0.5]/v1",
    "https://metadata.google.internal/computeMetadata/v1",
    // PR #608 regression: a fully-qualified name's trailing dot ("localhost.")
    // is the same host, but slipped past the exact-match host checks.
    "https://localhost./v1",
    "https://metadata.google.internal./computeMetadata/v1",
    "https://user:pass@llm.example.com/v1",
    "https://llm.example.com/v1?key=1",
    "https://llm.example.com/v1#x",
    `https://llm.example.com/${"a".repeat(300)}`,
    null,
  ])("rejects %j", (input) => {
    expect(normalizeCustomBaseUrl(input)).toBeNull();
  });
});

describe("credentials for a request", () => {
  const file = JSON.stringify({
    type: "service_account",
    project_id: "legal-prod",
    private_key: FAKE_PRIVATE_KEY,
    client_email: "mike@legal-prod.iam.gserviceaccount.com",
  });

  it("needs a user key and its own setting together", () => {
    expect(vertexCredentials({ vertex: file })).toBeNull();
    expect(
      vertexCredentials({
        vertex: file,
        providerSettings: { vertex: { location: "global" } },
      }),
    ).toMatchObject({ project: "legal-prod", location: "global" });
    expect(azureFoundryCredentials({ "azure-foundry": "k" })).toBeNull();
    expect(
      azureFoundryCredentials({
        "azure-foundry": "k",
        providerSettings: { "azure-foundry": { endpoint: "contoso" } },
      }),
    ).toEqual({
      apiKey: "k",
      endpoint: "https://contoso.services.ai.azure.com",
    });
  });

  it("has no environment form for a custom endpoint", () => {
    expect(customEndpointCredentials({})).toBeNull();
    expect(
      customEndpointCredentials({
        providerSettings: { custom: { baseUrl: "https://llm.example.com/v1" } },
      }),
    ).toBeNull();
    expect(
      customEndpointCredentials({
        custom: " sk-1 ",
        providerSettings: { custom: { baseUrl: "https://llm.example.com/v1" } },
      }),
    ).toEqual({ apiKey: "sk-1", baseUrl: "https://llm.example.com/v1" });
  });
});

describe("awsDnsSuffix", () => {
  it.each([
    ["us-east-1", "amazonaws.com"],
    ["us-gov-west-1", "amazonaws.com"],
    ["cn-north-1", "amazonaws.com.cn"],
    ["us-iso-east-1", "c2s.ic.gov"],
    ["us-isob-east-1", "sc2s.sgov.gov"],
    ["eusc-de-east-1", "amazonaws.eu"],
  ])("maps %s to %s", (region, suffix) => {
    expect(awsDnsSuffix(region)).toBe(suffix);
    expect(bedrockServiceUrl("bedrock-runtime", region)).toBe(`https://bedrock-runtime.${region}.${suffix}`);
  });
});
