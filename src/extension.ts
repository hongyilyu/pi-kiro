// pi-kiro extension entry point.
//
// Referenced from package.json: "pi": { "extensions": ["./dist/extension.js"] }.
// Called once by pi at startup; registers the kiro provider with its model
// catalog, OAuth login, and custom streaming handler.
//
// TODO: pi should prevent /login from firing mid-turn. Until enforced
// upstream, loginKiro assumes the agent is idle.
//
// TODO: fetchUsage is not part of the documented ProviderConfig contract in
// pi-coding-agent. When upstream pi documents the fetchUsage hook, add
// `fetchUsage: fetchKiroUsage` here to expose Kiro subscription usage in
// pi's /settings view. Until then, users check their usage at
// https://app.kiro.dev/account/usage.

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  fetchAvailableKiroModels,
  filterModelsByRegion,
  getCachedDynamicModels,
  kiroModels,
  resolveApiRegion,
} from "./models";
import { loginKiro, refreshKiroToken, type KiroCredentials } from "./oauth";
import { streamKiro } from "./stream";

// Local structural subset of pi's ExtensionAPI / ProviderConfig. pi-kiro
// only calls `pi.registerProvider(...)`, so we declare just that method
// plus the config shape we actually pass. Declared locally (not imported
// from @mariozechner/pi-coding-agent) so this package has no install-time
// dependency on the pi host's version. Any real pi ExtensionAPI satisfies
// this interface structurally.
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

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("kiro", {
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    api: "kiro-api",
    models: kiroModels,
    oauth: {
      name: "Kiro (Builder ID / IAM Identity Center)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access as string,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials): Model<Api>[] => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const kiroOnly = models.filter((m) => m.provider === "kiro");
        const nonKiro = models.filter((m) => m.provider !== "kiro");

        // Trigger dynamic discovery in the background if access token is available
        const token = (cred as KiroCredentials).access as string | undefined;
        if (token) {
          fetchAvailableKiroModels({ accessToken: token, region: apiRegion }).catch(() => {});
        }

        const cached = getCachedDynamicModels(apiRegion);
        const scoped = (cached ?? filterModelsByRegion(kiroOnly, apiRegion)).map((m) => ({
          ...m,
          baseUrl: `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`,
        }));
        return [...nonKiro, ...scoped];
      },
    },
    streamSimple: streamKiro,
  });
}
