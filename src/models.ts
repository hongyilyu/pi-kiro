// Kiro model catalog + ID conversion + region mapping + dynamic discovery.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

import { log } from "./debug";

/** Canonical Kiro API IDs (dot form) accepted by the server. */
export const KIRO_MODEL_IDS = new Set<string>([
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-1m",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "glm-5",
  "deepseek-3.2",
  "kimi-k2.5",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-4.7",
  "glm-4.7-flash",
  "qwen3-coder-next",
  "agi-nova-beta-1m",
  "qwen3-coder-480b",
  "auto",
]);

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6, gpt-5-6-sol → gpt-5.6-sol). */
export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  if (!KIRO_MODEL_IDS.has(kiroId)) {
    // Forward-compatibility: allow newly launched models, dynamically discovered models,
    // or custom models without crashing stream requests.
    log.debug(`Unlisted model ID: "${modelId}" -> "${kiroId}" (forward-compatible resolution)`);
  }
  return kiroId;
}

/** Convert Kiro API's dot form to pi's dash form (e.g. 4.6 → 4-6, gpt-5.6-sol → gpt-5-6-sol). */
export function toPiModelId(kiroId: string): string {
  return kiroId.replace(/(\d)\.(\d)/g, "$1-$2");
}

/**
 * Map an SSO/OIDC region to the Kiro API region. The Kiro Q API is only
 * deployed in a subset of regions; tokens issued in e.g. eu-west-1 must be
 * sent to the eu-central-1 API endpoint.
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
 * Source: https://kiro.dev/docs/models/available-models/
 */
const MODELS_BY_REGION: Record<string, Set<string>> = {
  "us-east-1": new Set([
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-6-1m",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-1m",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-1m",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-6-luna",
    "glm-5",
    "deepseek-3-2",
    "kimi-k2-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "glm-4-7",
    "glm-4-7-flash",
    "qwen3-coder-next",
    "qwen3-coder-480b",
    "agi-nova-beta-1m",
    "auto",
  ]),
  "eu-central-1": new Set([
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-6-luna",
    "glm-5",
    "minimax-m2-1",
    "minimax-m2-5",
    "qwen3-coder-next",
    "auto",
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

const BASE_URL = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Fields every Kiro model shares. Spread into each literal below. */
const KIRO_DEFAULTS = {
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl: BASE_URL,
  cost: ZERO_COST,
} as const;

type Input = ("text" | "image")[];
const MULTIMODAL: Input = ["text", "image"];
const TEXT_ONLY: Input = ["text"];

export interface KiroModel {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  input: Input;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** Optional per-model override for the first-token timeout (ms). */
  firstTokenTimeout?: number;
  /**
   * Upstream hides reasoning from clients — no `<thinking>` tags, no native
   * reasoning event. We emit a redacted ThinkingContent shim so downstream
   * UIs can surface a "reasoning hidden" marker. Also disables the
   * `<thinking_mode>` system-prompt directive, which the provider ignores.
   *
   * Applies to Claude Opus 5 and Claude Opus 4.7, which have adaptive-thinking
   * default "omitted".
   * See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
   */
  reasoningHidden?: boolean;
}

export const kiroModels: KiroModel[] = [
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    reasoningHidden: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    reasoningHidden: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5-1m",
    name: "Claude Sonnet 4.5 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7",
    name: "GLM 4.7",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7-flash",
    name: "GLM 4.7 Flash",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
];

// ---- Dynamic Model Discovery (ListAvailableModels) --------------------

export interface RawKiroModel {
  modelId: string;
  modelName?: string;
  description?: string;
  supportsPromptCaching?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface ListAvailableModelsResponse {
  models?: RawKiroModel[];
  modelSummaries?: RawKiroModel[];
}

/** In-memory cache for dynamically discovered models per region (5 min TTL). */
const dynamicModelCache = new Map<string, { models: KiroModel[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;

const lastFetchAttempt = new Map<string, number>();
const inFlightFetches = new Map<string, Promise<KiroModel[] | null>>();

export function getCachedDynamicModels(apiRegion: string): KiroModel[] | null {
  const entry = dynamicModelCache.get(apiRegion);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.models;
  }
  return null;
}

export function clearDynamicModelCache(): void {
  dynamicModelCache.clear();
  lastFetchAttempt.clear();
  inFlightFetches.clear();
}

/**
 * Dynamically fetch available models from the official Kiro / AWS CodeWhisperer endpoint
 * using the user's OAuth access token.
 */
export async function fetchAvailableKiroModels(options: {
  accessToken: string;
  region?: string;
  timeoutMs?: number;
}): Promise<KiroModel[] | null> {
  const { accessToken, region, timeoutMs = 5000 } = options;
  const apiRegion = resolveApiRegion(region);

  const cached = getCachedDynamicModels(apiRegion);
  if (cached) {
    return cached;
  }

  // Deduplicate concurrent in-flight fetches for the same region
  const existing = inFlightFetches.get(apiRegion);
  if (existing) {
    return existing;
  }

  // Cooldown after failed attempts to avoid hammering endpoint or logging spam
  const lastAttempt = lastFetchAttempt.get(apiRegion) ?? 0;
  if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) {
    return null;
  }

  const fetchPromise = (async (): Promise<KiroModel[] | null> => {
    lastFetchAttempt.set(apiRegion, Date.now());
    const endpoint = `https://q.${apiRegion}.amazonaws.com/`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ origin: "AI_EDITOR" }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        log.debug(`ListAvailableModels failed with status ${res.status}: ${res.statusText}`);
        return null;
      }

      const data = (await res.json()) as ListAvailableModelsResponse;
      const rawModels = data.models ?? data.modelSummaries ?? [];
      if (!Array.isArray(rawModels) || rawModels.length === 0) {
        return null;
      }

      const baseUrl = `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`;
      const resolvedModels: KiroModel[] = rawModels.map((raw) => {
        const piId = toPiModelId(raw.modelId);
        const staticMatch = kiroModels.find((m) => m.id === piId || resolveKiroModel(m.id) === raw.modelId);

        if (staticMatch) {
          return {
            ...staticMatch,
            baseUrl,
            ...(raw.maxInputTokens ? { contextWindow: raw.maxInputTokens } : {}),
            ...(raw.maxOutputTokens ? { maxTokens: raw.maxOutputTokens } : {}),
          };
        }

        // Model newly launched by Kiro not yet in static catalog
        return {
          ...KIRO_DEFAULTS,
          id: piId,
          name: raw.modelName || raw.modelId,
          baseUrl,
          reasoning:
            raw.reasoning ??
            (raw.modelId.includes("opus") ||
              raw.modelId.includes("reasoning") ||
              raw.modelId.includes("glm") ||
              raw.modelId.includes("sol")),
          input: raw.input ?? MULTIMODAL,
          contextWindow: raw.maxInputTokens ?? 200_000,
          maxTokens: raw.maxOutputTokens ?? 32_768,
        };
      });

      dynamicModelCache.set(apiRegion, {
        models: resolvedModels,
        timestamp: Date.now(),
      });

      return resolvedModels;
    } catch (err) {
      log.debug("fetchAvailableKiroModels error:", err);
      return null;
    } finally {
      inFlightFetches.delete(apiRegion);
    }
  })();

  inFlightFetches.set(apiRegion, fetchPromise);
  return fetchPromise;
}
