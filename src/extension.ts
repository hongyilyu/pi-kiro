// pi-kiro extension entry point.
//
// Referenced from package.json: "pi": { "extensions": ["./dist/extension.js"] }.
// Called once by pi at startup; registers the kiro provider with its model
// catalog, OAuth login, and custom streaming handler.
//
// Model list is fetched dynamically from Kiro's ListAvailableModels API.
// No hardcoded model list — if the API is unreachable or the user hasn't
// logged in yet, the provider is registered with an empty model list
// (the user must /login kiro first).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  buildModelsFromApi,
  fetchAvailableModels,
  filterModelsByRegion,
  resolveApiRegion,
  type KiroModelDef,
} from "./models";
import { loginKiro, refreshKiroToken, type KiroCredentials } from "./oauth";
import { streamKiro } from "./stream";

// Local structural subset of pi's ExtensionAPI / ProviderConfig.
// Declared locally so this package has no install-time dependency on
// the pi host's version. pi's real ExtensionAPI satisfies this structurally.
interface ProviderModelConfig {
  id: string;
  name: string;
  api?: Api;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
  firstTokenTimeout?: number;
  reasoningHidden?: boolean;
}

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ProviderModelConfig[];
  oauth?: {
    name: string;
    login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
    refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
    getApiKey: (credentials: OAuthCredentials) => string;
    modifyModels?: (models: Model<Api>[], credentials: OAuthCredentials) => Model<Api>[];
  };
}

interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
}

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function toProviderModels(defs: KiroModelDef[]): ProviderModelConfig[] {
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    reasoning: d.reasoning,
    input: d.input,
    cost: ZERO_COST,
    contextWindow: d.contextWindow,
    maxTokens: d.maxTokens,
    firstTokenTimeout: d.firstTokenTimeout,
    ...(d.reasoningHidden ? { reasoningHidden: d.reasoningHidden } : {}),
  }));
}

/** Read kiro credentials from pi's auth.json if available. */
function readKiroCredentials(): { access: string; region: string } | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return null;
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    const kiro = data["kiro"] as Record<string, unknown> | undefined;
    if (!kiro?.access || typeof kiro.access !== "string") return null;
    return {
      access: kiro.access,
      region: (kiro.region as string) || "us-east-1",
    };
  } catch {
    return null;
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Fetch available models from Kiro API. No hardcoded fallback.
  let modelDefs: KiroModelDef[] = [];
  const creds = readKiroCredentials();
  if (creds) {
    try {
      const apiRegion = resolveApiRegion(creds.region);
      const apiModels = await fetchAvailableModels(creds.access, apiRegion);
      modelDefs = buildModelsFromApi(apiModels);
    } catch {
      // API unreachable or credentials expired. Provider will have no models
      // until the user runs /login kiro (which refreshes credentials and
      // triggers modifyModels to re-resolve).
    }
  }

  pi.registerProvider("kiro", {
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    api: "kiro-api",
    authHeader: true,
    models: toProviderModels(modelDefs),
    oauth: {
      name: "Kiro (Builder ID / IAM Identity Center)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access as string,
      modifyModels: (allModels: Model<Api>[], cred: OAuthCredentials): Model<Api>[] => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const kiroOnly = allModels.filter((m) => m.provider === "kiro");
        const nonKiro = allModels.filter((m) => m.provider !== "kiro");
        const scoped = filterModelsByRegion(kiroOnly, apiRegion).map((m) => ({
          ...m,
          baseUrl: `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`,
        }));
        return [...nonKiro, ...scoped];
      },
    },
    streamSimple: streamKiro,
  });
}
