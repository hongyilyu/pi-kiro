// Kiro OAuth — AWS Builder ID and IAM Identity Center (IdC).
//
// Two login methods, selected interactively:
//
//   1. Builder ID — AWS's personal-account SSO. Fixed start URL
//      (https://view.awsapps.com/start), always us-east-1.
//   2. IdC — enterprise SSO. User supplies their company start URL
//      (e.g. https://mycompany.awsapps.com/start); region is auto-detected
//      across common AWS regions, or the user can specify it.
//
// Both methods use the same AWS SSO-OIDC device-code flow and the same
// refresh endpoint. Social login (Google/GitHub) is not supported — it
// requires kiro-cli, which we intentionally don't depend on.
//
// NOTE on mirrored-cursor rendering glitch:
// pi's login-dialog (modes/interactive/components/login-dialog.ts) appends
// `this.input` to `contentContainer` on every `showPrompt` call without
// clearing the container first. The second `onPrompt` call therefore shows
// two visible Input widgets bound to the same buffer — typing in one updates
// both. Our user's input is still captured correctly (both widgets share
// `this.input`). The glitch is cosmetic, upstream, and out of scope for this
// extension to fix. Report upstream: add `this.contentContainer.clear()` at
// the top of `showPrompt`, or allocate a new Input per call.

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";

export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_REGION = "us-east-1";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
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

/** 5-minute safety buffer subtracted from real token expiry. */
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  /**
   * OIDC client secret from AWS SSO-OIDC client registration.
   *
   * SENSITIVE: persist only in secure storage (e.g. keychain, encrypted
   * file, HTTP-only cookie). Do not log, do not send to telemetry, do not
   * embed in URLs or query strings. Together with `refresh`, it can mint
   * new access tokens for the user's AWS identity.
   */
  clientSecret: string;
  region: string;
  /**
   * Which SSO flow produced this credential.
   * - `builder-id`: AWS Builder ID (personal AWS account, us-east-1).
   * - `idc`: IAM Identity Center (enterprise SSO, any region).
   */
  authMethod: "builder-id" | "idc";
}

interface DeviceAuthResponse {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

interface ClientRegisterResponse {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Promise-based delay that rejects promptly if the signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function tryRegisterAndAuthorize(
  startUrl: string,
  region: string,
): Promise<{
  clientId: string;
  clientSecret: string;
  oidcEndpoint: string;
  devAuth: DeviceAuthResponse;
} | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  const regResp = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({
      clientName: "pi-kiro",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) return null;
  const { clientId, clientSecret } = (await regResp.json()) as ClientRegisterResponse;

  const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!devResp.ok) return null;

  return {
    clientId,
    clientSecret,
    oidcEndpoint,
    devAuth: (await devResp.json()) as DeviceAuthResponse,
  };
}

async function pollForToken(
  oidcEndpoint: string,
  clientId: string,
  clientSecret: string,
  devAuth: DeviceAuthResponse,
  signal: AbortSignal | undefined,
): Promise<TokenResponse> {
  const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
  const baseInterval = (devAuth.interval || 5) * 1000;
  let interval = baseInterval;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await abortableDelay(interval, signal);

    const resp = await fetch(`${oidcEndpoint}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-kiro" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode: devAuth.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await resp.json()) as TokenResponse;

    if (!data.error && data.accessToken && data.refreshToken) return data;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval += baseInterval;
      continue;
    }
    if (data.error) throw new Error(`Authorization failed: ${data.error}`);
  }
  throw new Error("Authorization timed out");
}

/**
 * Interactive login. Asks the user to pick Builder ID or IdC, then the IdC
 * region, then runs the device-code flow.
 *
 * Uses `callbacks.onPrompt`, which is the path pi's login-dialog is wired
 * to. Escape/ctrl+c rejects the promise with "Login cancelled", propagating
 * out of this function automatically.
 */
export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
  const urlRaw = await callbacks.onPrompt({
    message:
      "Login method: leave blank for AWS Builder ID, or paste an IAM Identity Center start URL (https://…)",
    placeholder: "https://mycompany.awsapps.com/start",
    allowEmpty: true,
  });

  const startUrl = (urlRaw ?? "").trim();
  if (!startUrl) {
    return runDeviceCodeFlow(callbacks, BUILDER_ID_START_URL, [BUILDER_ID_REGION], "builder-id");
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

  return runDeviceCodeFlow(callbacks, startUrl, regions, "idc");
}

async function runDeviceCodeFlow(
  callbacks: OAuthLoginCallbacks,
  startUrl: string,
  regions: string[],
  authMethod: "builder-id" | "idc",
): Promise<KiroCredentials> {
  let result: Awaited<ReturnType<typeof tryRegisterAndAuthorize>> | null = null;
  let detectedRegion = "";
  for (const region of regions) {
    result = await tryRegisterAndAuthorize(startUrl, region);
    if (result) {
      detectedRegion = region;
      if (regions.length > 1) callbacks.onProgress?.(`Region: ${region}`);
      break;
    }
  }
  if (!result || !detectedRegion) {
    throw new Error(
      `Could not authorize ${startUrl} in ${regions.join(", ")}. ` +
        `Check your start URL${regions.length === 1 ? " and region" : ""} and try again.`,
    );
  }

  // Pi's login-dialog renders `url` prominently (clickable link on macOS)
  // and auto-opens the browser. `instructions` appears below in warning
  // color — use it for the code + expiry hint only. Don't duplicate the URL.
  callbacks.onAuth({
    url: result.devAuth.verificationUriComplete,
    instructions: `Code: ${result.devAuth.userCode}\nComplete authorization within 10 minutes.`,
  });

  callbacks.onProgress?.("Waiting for browser authorization (up to 10 minutes)…");

  const tok = await pollForToken(
    result.oidcEndpoint,
    result.clientId,
    result.clientSecret,
    result.devAuth,
    callbacks.signal,
  );
  if (!tok.accessToken || !tok.refreshToken) {
    throw new Error("Authorization completed but no tokens returned");
  }

  return {
    refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|${authMethod}`,
    access: tok.accessToken,
    expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    clientId: result.clientId,
    clientSecret: result.clientSecret,
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
  // Preserve whatever authMethod came in. Fall back to "idc" only for
  // pre-existing credentials written before this field was tracked; never
  // invent "builder-id" because we can't tell the difference retroactively.
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
    expiresIn: number;
  };

  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod,
  };
}
