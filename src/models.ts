// Kiro model catalog + ID conversion + region mapping + dynamic resolution.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file uses the pi/dash
// form for model definitions, and converts to dot form for API calls.

// ---- ID conversion ---------------------------------------------------

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function dashToDot(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

/** Convert Kiro API's dot form to pi's dash form (e.g. 4.6 → 4-6). */
export function dotToDash(modelId: string): string {
  return modelId.replace(/(\d)\.(\d)/g, "$1-$2");
}

/**
 * Resolve a pi model ID to the Kiro API format.
 * Kept for backward compatibility — delegates to dashToDot.
 */
export function resolveKiroModel(modelId: string): string {
  return dashToDot(modelId);
}

// ---- Region mapping ---------------------------------------------------

/**
 * Map an SSO/OIDC region to the Kiro API region. The Kiro Q API is only
 * deployed in a subset of regions; tokens issued in e.g. eu-west-1 must
 * be sent to the eu-central-1 API endpoint.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

/**
 * Models available per API region (allowlist). Unknown regions return an
 * empty list — update this map when Kiro launches in a new region.
 * Source: https://kiro.dev/docs/cli/models/
 */
const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set([
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-6-1m",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "deepseek-3-2",
    "kimi-k2-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-4-7",
    "glm-4-7-flash",
    "glm-5",
    "qwen3-coder-next",
    "qwen3-coder-480b",
    "agi-nova-beta-1m",
  ]),
  "eu-central-1": new Set([
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-4-7",
    "glm-4-7-flash",
    "glm-5",
    "qwen3-coder-next",
  ]),
};

export function filterModelsByRegion<T extends { id: string }>(
  models: T[],
  apiRegion: string,
): T[] {
  const allowed = MODELS_BY_REGION[apiRegion];
  if (!allowed) {
    console.warn(
      `[pi-kiro] Unknown API region "${apiRegion}" — no models available. Update MODELS_BY_REGION in models.ts.`,
    );
    return [];
  }
  return models.filter((m) => allowed.has(m.id));
}

// ---- Dynamic model resolution -----------------------------------------

interface KiroApiModel {
  modelId: string;
  modelName: string;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
  supportedInputTypes?: string[];
}

/**
 * Fetch the list of models actually available for this account from Kiro.
 * Filters out "auto" — it appears in ListAvailableModels but is rejected
 * by GenerateAssistantResponse with INVALID_MODEL_ID.
 */
export async function fetchAvailableModels(
  accessToken: string,
  apiRegion: string,
): Promise<KiroApiModel[]> {
  const url = `https://q.${apiRegion}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "pi-kiro",
    },
  });
  if (!resp.ok) {
    throw new Error(`ListAvailableModels failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { models?: KiroApiModel[] };
  return (data.models ?? []).filter((m) => m.modelId !== "auto");
}

/** Model families known to support reasoning/thinking. */
const REASONING_FAMILIES = new Set([
  "claude-sonnet", "claude-opus",
  "deepseek", "kimi", "glm", "qwen3-coder", "agi-nova",
]);

function isReasoningModel(dotId: string): boolean {
  for (const family of REASONING_FAMILIES) {
    if (dotId.startsWith(family)) return true;
  }
  return false;
}

/** First-token timeout for slow models (Claude Opus can take 2-3 minutes). */
function firstTokenTimeout(dotId: string): number {
  if (dotId.startsWith("claude-opus")) return 180_000;
  return 90_000;
}

export interface KiroModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  firstTokenTimeout?: number;
}

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Build pi model definitions from the Kiro ListAvailableModels API response.
 * No hardcoded model list — everything comes from the API.
 */
export function buildModelsFromApi(apiModels: KiroApiModel[]): KiroModelDef[] {
  return apiModels.map((m) => {
    const dashId = dotToDash(m.modelId);
    const supportedTypes = m.supportedInputTypes ?? ["TEXT"];
    const input: ("text" | "image")[] = supportedTypes.includes("IMAGE")
      ? ["text", "image"]
      : ["text"];

    return {
      id: dashId,
      name: m.modelName,
      reasoning: isReasoningModel(m.modelId),
      input,
      contextWindow: m.tokenLimits?.maxInputTokens ?? 200_000,
      maxTokens: m.tokenLimits?.maxOutputTokens ?? 8_192,
      firstTokenTimeout: firstTokenTimeout(m.modelId),
      // Per-model overrides for known special cases
      ...(m.modelId === "claude-opus-4.7" ? { reasoningHidden: true } : {}),
    };
  });
}
