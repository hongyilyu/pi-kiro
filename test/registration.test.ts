import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/extension";

describe("extension registration", () => {
  it("calls pi.registerProvider with 'kiro' and all documented fields", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];

    await registerExtension(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    const [name, config] = registerProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("kiro");
    expect(config.baseUrl).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse");
    expect(config.api).toBe("kiro-api");
    expect(Array.isArray(config.models)).toBe(true);
    expect((config.models as unknown[]).length).toBeGreaterThan(0);
    expect(typeof config.streamSimple).toBe("function");

    const oauth = config.oauth as Record<string, unknown>;
    expect(oauth.name).toBe("Kiro (Builder ID / IAM Identity Center)");
    expect(typeof oauth.login).toBe("function");
    expect(typeof oauth.refreshToken).toBe("function");
    expect(typeof oauth.getApiKey).toBe("function");
    expect(typeof oauth.modifyModels).toBe("function");
  });

  it("config uses only documented ProviderConfig fields (no undocumented extensions)", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    const allowedKeys = new Set([
      "baseUrl",
      "apiKey",
      "api",
      "streamSimple",
      "headers",
      "authHeader",
      "models",
      "oauth",
    ]);
    for (const key of Object.keys(config)) {
      expect(allowedKeys.has(key), `Unexpected ProviderConfig key: ${key}`).toBe(true);
    }

    const oauth = config.oauth as Record<string, unknown>;
    const allowedOAuthKeys = new Set(["name", "login", "refreshToken", "getApiKey", "modifyModels"]);
    for (const key of Object.keys(oauth)) {
      expect(allowedOAuthKeys.has(key), `Unexpected oauth key: ${key}`).toBe(true);
    }
  });

  it("getApiKey returns credentials.access", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);
    const oauth = registerProvider.mock.calls[0]?.[1]?.oauth as {
      getApiKey: (c: Record<string, unknown>) => string;
    };
    expect(oauth.getApiKey({ access: "TOKEN", refresh: "R", expires: 0 })).toBe("TOKEN");
  });

  it("modifyModels scopes Kiro models to apiRegion and rewrites baseUrl", async () => {
    const registerProvider = vi.fn();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      on: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];
    await registerExtension(pi);

    const oauth = registerProvider.mock.calls[0]?.[1]?.oauth as {
      modifyModels: (models: unknown[], cred: Record<string, unknown>) => unknown[];
    };
    const models = registerProvider.mock.calls[0]?.[1]?.models as Array<{
      id: string;
      provider: string;
    }>;

    const scoped = oauth.modifyModels(models, {
      refresh: "r",
      access: "a",
      expires: 0,
      region: "eu-west-1",
    }) as Array<{ id: string; baseUrl: string; provider: string }>;

    expect(scoped.length).toBeGreaterThan(0);
    for (const m of scoped) {
      if (m.provider === "kiro") {
        expect(m.baseUrl).toBe(
          "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
        );
      }
    }
  });
});
