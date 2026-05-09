import { describe, expect, it } from "vitest";
import {
  filterModelsByRegion,
  KIRO_MODEL_IDS,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
} from "../src/models";

describe("resolveKiroModel", () => {
  it("converts dashes between digits to dots", () => {
    expect(resolveKiroModel("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
    expect(resolveKiroModel("claude-opus-4-7")).toBe("claude-opus-4.7");
    expect(resolveKiroModel("glm-4-7-flash")).toBe("glm-4.7-flash");
  });

  it("preserves IDs without digit-dash-digit patterns", () => {
    expect(resolveKiroModel("auto")).toBe("auto");
    expect(resolveKiroModel("qwen3-coder-next")).toBe("qwen3-coder-next");
  });

  it("throws on unknown model IDs", () => {
    expect(() => resolveKiroModel("gpt-4")).toThrow(/Unknown Kiro model ID/);
  });

  it("every kiroModels entry resolves to a known Kiro ID", () => {
    for (const m of kiroModels) {
      expect(() => resolveKiroModel(m.id)).not.toThrow();
      expect(KIRO_MODEL_IDS.has(resolveKiroModel(m.id))).toBe(true);
    }
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
    expect(resolveApiRegion("me-south-1")).toBe("me-south-1");
  });
});

describe("filterModelsByRegion", () => {
  it("returns models available in us-east-1", () => {
    const r = filterModelsByRegion(kiroModels, "us-east-1");
    expect(r.length).toBeGreaterThan(0);
    expect(r.find((m) => m.id === "claude-opus-4-7")).toBeDefined();
  });

  it("returns a narrower subset for eu-central-1", () => {
    const us = filterModelsByRegion(kiroModels, "us-east-1");
    const eu = filterModelsByRegion(kiroModels, "eu-central-1");
    expect(eu.length).toBeGreaterThan(0);
    expect(eu.length).toBeLessThan(us.length);
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
});
