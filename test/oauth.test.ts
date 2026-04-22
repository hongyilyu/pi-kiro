import type { OAuthAuthInfo, OAuthLoginCallbacks, OAuthPrompt } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginKiro, refreshKiroToken } from "../src/oauth";

type FetchMock = ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}
function fail(status: number) {
  return { ok: false, status };
}

function scriptedPrompts(answers: string[]): OAuthLoginCallbacks {
  const queue = [...answers];
  const onPrompt = vi.fn(async (_p: OAuthPrompt) => {
    const next = queue.shift();
    return next ?? "";
  });
  return {
    onAuth: vi.fn(),
    onPrompt,
    onProgress: vi.fn(),
  };
}

describe("loginKiro — Builder ID", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("empty input triggers Builder ID device-code flow at us-east-1", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" }))
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://verify",
          verificationUriComplete: "https://verify?user_code=ABCD",
          userCode: "ABCD",
          deviceCode: "DEV",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    const callbacks = scriptedPrompts([""]); // blank → Builder ID
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.region).toBe("us-east-1");
    expect(creds.access).toBe("AT");
    expect(creds.refresh).toBe("RT|CID|SEC|builder-id");
    expect(creds.authMethod).toBe("builder-id");

    // Request 1: /client/register to us-east-1
    const firstUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstUrl).toContain("oidc.us-east-1.amazonaws.com/client/register");

    // Request 2: /device_authorization carries the Builder ID start URL
    const devBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(devBody.startUrl).toBe("https://view.awsapps.com/start");
  });
});

describe("loginKiro — IdC", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("IdC start URL + explicit region skips region probing", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" }))
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v",
          userCode: "X",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    // Two prompts: URL, then region.
    const callbacks = scriptedPrompts([
      "https://mycompany.awsapps.com/start",
      "eu-west-1",
    ]);
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.region).toBe("eu-west-1");
    const firstUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstUrl).toContain("oidc.eu-west-1.amazonaws.com");
    const devBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(devBody.startUrl).toBe("https://mycompany.awsapps.com/start");
  });

  it("URL alone auto-detects region by probing", async () => {
    vi.useFakeTimers();
    // us-east-1 register fails, eu-west-1 succeeds.
    fetchMock
      .mockResolvedValueOnce(fail(400)) // register us-east-1
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" })) // register eu-west-1
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v",
          userCode: "X",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    const callbacks = scriptedPrompts(["https://mycompany.awsapps.com/start"]);
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    const creds = await promise;

    expect(creds.region).toBe("eu-west-1");
  });

  it("rejects non-URL input that isn't blank", async () => {
    const callbacks = scriptedPrompts(["notaurl"]);
    await expect(loginKiro(callbacks)).rejects.toThrow(/Invalid input/);
  });

  it("throws if no region accepts the start URL", async () => {
    // Every probed region fails registration.
    fetchMock.mockResolvedValue(fail(400));
    const callbacks = scriptedPrompts([
      "https://bogus.awsapps.com/start",
      "us-east-1",
    ]);
    await expect(loginKiro(callbacks)).rejects.toThrow(/Could not authorize/);
  });

  it("surfaces onAuth with verificationUriComplete and userCode", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okJson({ clientId: "CID", clientSecret: "SEC" }))
      .mockResolvedValueOnce(
        okJson({
          verificationUri: "https://v",
          verificationUriComplete: "https://v?user_code=HELLO",
          userCode: "HELLO",
          deviceCode: "D",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(okJson({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }));

    const onAuth = vi.fn();
    const callbacks: OAuthLoginCallbacks = {
      onAuth,
      onPrompt: vi
        .fn()
        .mockResolvedValueOnce("https://x.awsapps.com/start")
        .mockResolvedValueOnce("us-east-1"),
    };
    const promise = loginKiro(callbacks);
    await vi.runAllTimersAsync();
    await promise;

    expect(onAuth).toHaveBeenCalledOnce();
    const info = onAuth.mock.calls[0]?.[0] as OAuthAuthInfo;
    expect(info.url).toBe("https://v?user_code=HELLO");
    expect(info.instructions).toContain("HELLO");
    expect(info.instructions).toContain("10 minutes");
  });

  it("propagates cancel when onPrompt rejects at the URL prompt", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onPrompt: vi.fn().mockRejectedValueOnce(new Error("Login cancelled")),
    };
    await expect(loginKiro(callbacks)).rejects.toThrow("Login cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates cancel when onPrompt rejects at the region prompt", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onPrompt: vi
        .fn()
        .mockResolvedValueOnce("https://x.awsapps.com/start")
        .mockRejectedValueOnce(new Error("Login cancelled")),
    };
    await expect(loginKiro(callbacks)).rejects.toThrow("Login cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshKiroToken", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refreshes using pipe-packed credentials at the stored region", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 3600 }),
    );
    const refreshed = await refreshKiroToken({
      refresh: "RT|CID|SEC|idc",
      access: "old",
      expires: 0,
      region: "eu-west-1",
    });
    expect(refreshed.access).toBe("AT2");
    expect(refreshed.refresh).toBe("RT2|CID|SEC|idc");
    expect(refreshed.region).toBe("eu-west-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oidc.eu-west-1.amazonaws.com/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientId: "CID",
          clientSecret: "SEC",
          refreshToken: "RT",
          grantType: "refresh_token",
        }),
      }),
    );
  });

  it("throws when region is missing", async () => {
    await expect(
      refreshKiroToken({ refresh: "RT|CID|SEC|idc", access: "x", expires: 0 }),
    ).rejects.toThrow(/missing clientId\/clientSecret\/region/);
  });

  it("throws when refresh token is missing pieces", async () => {
    await expect(
      refreshKiroToken({
        refresh: "just-a-token",
        access: "x",
        expires: 0,
        region: "us-east-1",
      }),
    ).rejects.toThrow(/missing clientId/);
  });

  it("throws on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(fail(401));
    await expect(
      refreshKiroToken({
        refresh: "RT|CID|SEC|idc",
        access: "x",
        expires: 0,
        region: "us-east-1",
      }),
    ).rejects.toThrow(/Token refresh failed/);
  });
});
