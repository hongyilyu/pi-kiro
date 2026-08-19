import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDynamicModelCache,
  fetchAvailableKiroModels,
  filterModelsByRegion,
  getCachedDynamicModels,
  KIRO_MODEL_IDS,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
  toPiModelId,
} from "../src/models";

describe("resolveKiroModel", () => {
  it("converts dashes between digits to dots", () => {
    expect(resolveKiroModel("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
    expect(resolveKiroModel("claude-opus-4-7")).toBe("claude-opus-4.7");
    expect(resolveKiroModel("claude-opus-4-8")).toBe("claude-opus-4.8");
    expect(resolveKiroModel("gpt-5-6-sol")).toBe("gpt-5.6-sol");
    expect(resolveKiroModel("gpt-5-6-terra")).toBe("gpt-5.6-terra");
    expect(resolveKiroModel("gpt-5-6-luna")).toBe("gpt-5.6-luna");
    expect(resolveKiroModel("glm-4-7-flash")).toBe("glm-4.7-flash");
  });

  it("preserves IDs without digit-dash-digit patterns", () => {
    expect(resolveKiroModel("claude-opus-5")).toBe("claude-opus-5");
    expect(resolveKiroModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveKiroModel("glm-5")).toBe("glm-5");
    expect(resolveKiroModel("auto")).toBe("auto");
    expect(resolveKiroModel("qwen3-coder-next")).toBe("qwen3-coder-next");
  });

  it("handles unknown or newly added model IDs without throwing", () => {
    expect(resolveKiroModel("gpt-4")).toBe("gpt-4");
    expect(resolveKiroModel("custom-model-2-1")).toBe("custom-model-2.1");
  });

  it("every kiroModels entry resolves to a known Kiro ID", () => {
    for (const m of kiroModels) {
      expect(() => resolveKiroModel(m.id)).not.toThrow();
      expect(KIRO_MODEL_IDS.has(resolveKiroModel(m.id))).toBe(true);
    }
  });
});

describe("toPiModelId", () => {
  it("converts dot notation to dash notation for numbers", () => {
    expect(toPiModelId("claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(toPiModelId("gpt-5.6-sol")).toBe("gpt-5-6-sol");
    expect(toPiModelId("claude-opus-5")).toBe("claude-opus-5");
    expect(toPiModelId("glm-5")).toBe("glm-5");
  });
});

describe("resolveApiRegion", () => {
  it("defaults to us-east-1 for undefined", () => {
    expect(resolveApiRegion(undefined)).toBe("us-east-1");
  });

  it("maps EU SSO regions to eu-central-1", () => {
    expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    expect(resolveApiRegion("eu-west-2")).toBe("eu-central-1");
    expect(resolveApiRegion("eu-north-1")).toBe("eu-central-1");
  });

  it("maps US SSO regions to us-east-1", () => {
    expect(resolveApiRegion("us-west-2")).toBe("us-east-1");
    expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
  });

  it("passes through unmapped regions", () => {
    expect(resolveApiRegion("ap-southeast-1")).toBe("ap-southeast-1");
  });
});

describe("filterModelsByRegion", () => {
  it("returns models available in us-east-1", () => {
    const r = filterModelsByRegion(kiroModels, "us-east-1");
    expect(r.length).toBeGreaterThan(0);
    expect(r.find((m) => m.id === "claude-opus-5")).toBeDefined();
    expect(r.find((m) => m.id === "claude-opus-4-8")).toBeDefined();
    expect(r.find((m) => m.id === "claude-sonnet-5")).toBeDefined();
    expect(r.find((m) => m.id === "gpt-5-6-sol")).toBeDefined();
    expect(r.find((m) => m.id === "glm-5")).toBeDefined();
    expect(r.find((m) => m.id === "claude-opus-4-7")).toBeDefined();
  });

  it("returns a narrower subset for eu-central-1", () => {
    const us = filterModelsByRegion(kiroModels, "us-east-1");
    const eu = filterModelsByRegion(kiroModels, "eu-central-1");
    expect(eu.length).toBeGreaterThan(0);
    expect(eu.length).toBeLessThan(us.length);
    expect(eu.find((m) => m.id === "claude-opus-5")).toBeDefined();
    expect(eu.find((m) => m.id === "gpt-5-6-sol")).toBeDefined();
  });

  it("returns empty for unknown regions", () => {
    const r = filterModelsByRegion(kiroModels, "atlantis-1");
    expect(r).toEqual([]);
  });
});

describe("kiroModels catalog", () => {
  it("every model uses the shared api/provider/baseUrl defaults", () => {
    for (const m of kiroModels) {
      expect(m.api).toBe("kiro-api");
      expect(m.provider).toBe("kiro");
      expect(m.baseUrl).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse");
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("has no duplicate IDs", () => {
    const ids = kiroModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes all latest frontier models", () => {
    const ids = new Set(kiroModels.map((m) => m.id));
    expect(ids.has("claude-opus-5")).toBe(true);
    expect(ids.has("claude-opus-4-8")).toBe(true);
    expect(ids.has("claude-sonnet-5")).toBe(true);
    expect(ids.has("gpt-5-6-sol")).toBe(true);
    expect(ids.has("gpt-5-6-terra")).toBe(true);
    expect(ids.has("gpt-5-6-luna")).toBe(true);
    expect(ids.has("glm-5")).toBe(true);
  });
});

describe("fetchAvailableKiroModels", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearDynamicModelCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearDynamicModelCache();
    vi.restoreAllMocks();
  });

  it("fetches and resolves models from ListAvailableModels endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            modelId: "claude-opus-5",
            modelName: "Claude Opus 5",
            maxInputTokens: 1000000,
            maxOutputTokens: 128000,
          },
          {
            modelId: "gpt-5.6-sol",
            modelName: "GPT-5.6 Sol",
          },
          {
            modelId: "future-new-model",
            modelName: "Future Model",
            maxInputTokens: 500000,
            maxOutputTokens: 50000,
          },
        ],
      }),
    } as unknown as Response) as unknown as typeof fetch;

    const models = await fetchAvailableKiroModels({
      accessToken: "test-token",
      region: "us-east-1",
    });

    expect(models).not.toBeNull();
    expect(models?.length).toBe(3);

    const opus5 = models?.find((m) => m.id === "claude-opus-5");
    expect(opus5).toBeDefined();
    expect(opus5?.name).toBe("Claude Opus 5");
    expect(opus5?.contextWindow).toBe(1000000);

    const gptSol = models?.find((m) => m.id === "gpt-5-6-sol");
    expect(gptSol).toBeDefined();

    const future = models?.find((m) => m.id === "future-new-model");
    expect(future).toBeDefined();
    expect(future?.contextWindow).toBe(500000);
    expect(future?.maxTokens).toBe(50000);

    // Verify cache hit
    const cached = getCachedDynamicModels("us-east-1");
    expect(cached).toEqual(models);

    // Second call should return cached without fetch
    const fetchCallsBefore = vi.mocked(globalThis.fetch).mock.calls.length;
    const secondCall = await fetchAvailableKiroModels({
      accessToken: "test-token",
      region: "us-east-1",
    });
    expect(secondCall).toEqual(models);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCallsBefore);
  });

  it("returns null when fetch returns non-200 error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as Response) as unknown as typeof fetch;

    const models = await fetchAvailableKiroModels({
      accessToken: "invalid-token",
      region: "us-east-1",
    });

    expect(models).toBeNull();
  });

  it("returns null when fetch rejects (network error/timeout)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network offline")) as unknown as typeof fetch;

    const models = await fetchAvailableKiroModels({
      accessToken: "test-token",
      region: "us-east-1",
    });

    expect(models).toBeNull();
  });
});
