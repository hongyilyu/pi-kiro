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
import { filterModelsByRegion, kiroModels, resolveApiRegion } from "./models";
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
    baseUrl: "https://runtime.us-east-1.kiro.dev",
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
        const scoped = filterModelsByRegion(kiroOnly, apiRegion).map((m) => {
          const endpoints: Record<string, string> = {
            "us-east-1": "https://runtime.us-east-1.kiro.dev",
            "eu-central-1": "https://runtime.eu-central-1.kiro.dev",
          };
          return {
            ...m,
            baseUrl: endpoints[apiRegion] ?? `https://runtime.${apiRegion}.kiro.dev`,
          };
        });
        return [...nonKiro, ...scoped];
      },
    },
    streamSimple: streamKiro,
  });
}
