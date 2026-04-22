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

import type { Api, Model, OAuthCredentials } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { filterModelsByRegion, kiroModels, resolveApiRegion } from "./models";
import { loginKiro, refreshKiroToken, type KiroCredentials } from "./oauth";
import { streamKiro } from "./stream";

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
