// Kiro OAuth — AWS Builder ID and IAM Identity Center (IdC).
//
// Uses PKCE Authorization Code flow (required by Kiro's API as of late 2026).
// Device code flow tokens are rejected by the backend with FEATURE_NOT_SUPPORTED.
//
// Two login methods, selected interactively:
//
//   1. Builder ID — AWS's personal-account SSO. Fixed start URL
//      (https://view.awsapps.com/start), always us-east-1.
//   2. IdC — enterprise SSO. User supplies their company start URL
//      (e.g. https://mycompany.awsapps.com/start); region is auto-detected
//      across common AWS regions, or the user can specify it.

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { createServer } from "node:http";
import { log } from "./debug";

export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_REGION = "us-east-1";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
];

/** Regions probed when an IdC user leaves the region blank. */
const IDC_PROBE_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "us-east-2",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2",
];

const REDIRECT_PORT_MIN = 49152;
const REDIRECT_PORT_MAX = 65535;
/** 5-minute safety buffer subtracted from real token expiry. */
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: "builder-id" | "idc";
}

interface TokenResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

function randomPort(): number {
  return Math.floor(Math.random() * (REDIRECT_PORT_MAX - REDIRECT_PORT_MIN + 1)) + REDIRECT_PORT_MIN;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const { randomBytes, createHash } = await import("node:crypto");
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface ClientRegisterResult {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

async function tryRegisterClient(
  startUrl: string,
  region: string,
  redirectUri: string,
): Promise<ClientRegisterResult | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  const regResp = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({
      clientName: "Kiro CLI",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [redirectUri],
      issuerUrl: startUrl,
    }),
  });
  if (!regResp.ok) {
    log.debug("pkce.register.failed", { region, status: regResp.status, body: await regResp.text().catch(() => "") });
    return null;
  }

  const data = (await regResp.json()) as {
    clientId: string;
    clientSecret: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
  };
  return {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    authorizationEndpoint: `${oidcEndpoint}/authorize`,
    tokenEndpoint: `${oidcEndpoint}/token`,
  };
}

function waitForCallback(port: number, signal?: AbortSignal): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (code && state) {
        res.end(
          "<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>",
        );
        server.close();
        resolve({ code, state });
      } else {
        res.end(
          `<html><body><h2>Authorization failed</h2><p>${error ?? "Unknown error"}</p></body></html>`,
        );
        server.close();
        reject(new Error(`OAuth callback error: ${error ?? "no code returned"}`));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      log.debug("pkce.callback.listening", { port });
    });

    server.on("error", (err) => {
      reject(new Error(`Callback server error: ${err.message}`));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        server.close();
        reject(new Error("Login cancelled"));
      }, { once: true });
    }
  });
}

async function exchangeCodeForToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      grantType: "authorization_code",
      code,
      redirectUri,
      codeVerifier: verifier,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => resp.statusText);
    throw new Error(`Token exchange failed: ${resp.status} ${txt}`);
  }

  return resp.json() as Promise<TokenResponse>;
}

export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
  const urlRaw = await callbacks.onPrompt({
    message:
      "Login method: leave blank for AWS Builder ID, or paste an IAM Identity Center start URL (https://…)",
    placeholder: "https://mycompany.awsapps.com/start",
    allowEmpty: true,
  });

  const startUrl = (urlRaw ?? "").trim();
  if (!startUrl) {
    return runPKCEFlow(callbacks, BUILDER_ID_START_URL, [BUILDER_ID_REGION], "builder-id");
  }
  if (!startUrl.startsWith("http")) {
    throw new Error(
      `Invalid input "${startUrl}" — leave blank for Builder ID, or paste your IdC start URL (https://…)`,
    );
  }

  const regionRaw = await callbacks.onPrompt({
    message: `Identity Center region, or blank to auto-detect (${IDC_PROBE_REGIONS.join(", ")})`,
    placeholder: "us-east-1",
    allowEmpty: true,
  });

  const region = (regionRaw ?? "").trim();
  const regions = region ? [region] : IDC_PROBE_REGIONS;
  callbacks.onProgress?.(
    region ? `Connecting to ${region}…` : "Detecting your Identity Center region…",
  );

  return runPKCEFlow(callbacks, startUrl, regions, "idc");
}

async function runPKCEFlow(
  callbacks: OAuthLoginCallbacks,
  startUrl: string,
  regions: string[],
  authMethod: "builder-id" | "idc",
): Promise<KiroCredentials> {
  const port = randomPort();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const { verifier, challenge } = await generatePKCE();
  const state = base64url(Buffer.from(Math.random().toString()));

  let reg: ClientRegisterResult | null = null;
  let detectedRegion = "";
  for (const region of regions) {
    reg = await tryRegisterClient(startUrl, region, redirectUri);
    if (reg) {
      detectedRegion = region;
      if (regions.length > 1) callbacks.onProgress?.(`Region: ${region}`);
      break;
    }
  }

  if (!reg || !detectedRegion) {
    throw new Error(
      `Could not register client for ${startUrl} in ${regions.join(", ")}. ` +
        `Check your start URL${regions.length === 1 ? " and region" : ""} and try again.`,
    );
  }

  const { clientId, clientSecret, authorizationEndpoint, tokenEndpoint } = reg;

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${authorizationEndpoint}?${authParams.toString()}`;

  callbacks.onAuth({
    url: authUrl,
    instructions: "A browser window will open. Authorize pi-kiro and return here.",
  });

  callbacks.onProgress?.("Waiting for browser authorization…");

  const callbackPromise = waitForCallback(port, callbacks.signal);

  // Auto-open browser
  try {
    const { exec } = await import("node:child_process");
    exec(`open "${authUrl}"`);
  } catch {
    // ignore — user can open manually from the URL shown above
  }

  const { code } = await callbackPromise;

  callbacks.onProgress?.("Exchanging authorization code for tokens…");

  const tok = await exchangeCodeForToken(tokenEndpoint, clientId, clientSecret, code, redirectUri, verifier);

  if (!tok.accessToken || !tok.refreshToken) {
    throw new Error("Authorization completed but no tokens returned");
  }

  return {
    refresh: `${tok.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    access: tok.accessToken,
    expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region: detectedRegion,
    authMethod,
  };
}

export async function refreshKiroToken(
  credentials: OAuthCredentials,
): Promise<KiroCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const region = (credentials as KiroCredentials).region;
  const inputMethod = (credentials as Partial<KiroCredentials>).authMethod;
  const authMethod: "builder-id" | "idc" =
    inputMethod === "builder-id" || inputMethod === "idc" ? inputMethod : "idc";

  if (!refreshToken || !clientId || !clientSecret || !region) {
    throw new Error(
      "Refresh token is missing clientId/clientSecret/region — re-login required",
    );
  }

  const endpoint = `https://oidc.${region}.amazonaws.com/token`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

  const data = (await resp.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  };

  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    access: data.accessToken,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod,
  };
}
