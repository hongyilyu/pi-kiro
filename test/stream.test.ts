import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_REASONING_COUNTDOWN_MS, resetProfileArnCache, streamKiro } from "../src/stream";

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
    ...overrides,
  };
}

function makeContext(userMsg = "Hello"): Context {
  return {
    systemPrompt: "You are helpful",
    messages: [{ role: "user", content: userMsg, timestamp: Date.now() }],
    tools: [],
  };
}

async function collect(
  stream: ReturnType<typeof streamKiro>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

function mockFetchOk(body: string) {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    },
  });
}

describe("streamKiro", () => {
  beforeEach(() => {
    resetProfileArnCache(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits error when no credentials", async () => {
    const events = await collect(streamKiro(makeModel(), makeContext(), {}));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.errorMessage).toContain("/login kiro");
    }
  });

  it("emits aborted when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "t", signal: ac.signal }),
    );
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.stopReason).toBe("aborted");
    }
  });

  it("sends POST with expected headers", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.stubGlobal("fetch", fetchMock);

    await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    const call = fetchMock.mock.calls[0];
    const [url, opts] = call as [string, { headers: Record<string, string>; method: string; body: string }];
    expect(url).toContain("generateAssistantResponse");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    );
    expect(opts.headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
    expect(opts.headers["Content-Type"]).toBe("application/x-amz-json-1.0");
  });

  it("parses text + contextUsage into usage", async () => {
    vi.stubGlobal("fetch", mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("stop");
      expect(done.message.usage.input).toBe(20000);
      expect(done.message.usage.totalTokens).toBeGreaterThan(20000);
      expect(done.message.content.some((b) => b.type === "text")).toBe(true);
    }
  });

  it("emits toolUse stopReason when tool called", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    vi.stubGlobal("fetch", mockFetchOk(`${toolPayload}{"contextUsagePercentage":20}`));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") expect(done.reason).toBe("toolUse");
  });

  it("returns length when no contextUsage and no tool calls", async () => {
    vi.stubGlobal("fetch", mockFetchOk('{"content":"Partial"}'));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") expect(done.reason).toBe("length");
  });

  it("413 propagates with context_length_exceeded marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("too big"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.errorMessage).toMatch(/context_length_exceeded/);
    }
  });

  it("MONTHLY_REQUEST_COUNT does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad",
      text: () => Promise.resolve("MONTHLY_REQUEST_COUNT exceeded"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolveProfileArn includes ARN in body and caches per endpoint", async () => {
    resetProfileArnCache(false);
    const arn = "arn:aws:codewhisperer:us-east-1:123:profile/TEST";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn }] }) })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
      });
    vi.stubGlobal("fetch", fetchMock);
    await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererService.ListAvailableProfiles",
    );
    const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(body.profileArn).toBe(arn);

    // Second call reuses cache (no extra ListAvailableProfiles).
    const fetchMock2 = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", fetchMock2);
    await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    expect(fetchMock2).toHaveBeenCalledOnce();
  });

  it("sends origin: KIRO_CLI and modelId in dot format", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", fetchMock);
    await collect(
      streamKiro(makeModel({ id: "claude-sonnet-4-5" }), makeContext(), { apiKey: "tok" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.conversationState.currentMessage.userInputMessage.origin).toBe("KIRO_CLI");
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(body.conversationState.agentTaskType).toBe("vibe");
    expect(body.agentMode).toBe("vibe");
  });

  it("injects thinking mode tags when reasoning is enabled", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.stubGlobal("fetch", fetchMock);
    await collect(
      streamKiro(makeModel({ reasoning: true }), makeContext(), {
        apiKey: "tok",
        reasoning: "high",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<thinking_mode>enabled</thinking_mode>",
    );
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<max_thinking_length>30000",
    );
  });

  describe("reasoningHidden models (Claude 4.7)", () => {
    const hiddenModel = (): Model<Api> =>
      makeModel({
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        // reasoningHidden is a KiroModel-only field; cast through unknown
        // because Model<Api> doesn't declare it.
        ...({ reasoningHidden: true } as unknown as Partial<Model<Api>>),
      });

    it("skips <thinking_mode> system-prompt directive", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.stubGlobal("fetch", fetchMock);
      await collect(
        streamKiro(hiddenModel(), makeContext(), { apiKey: "tok", reasoning: "high" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const content = body.conversationState.currentMessage.userInputMessage.content as string;
      expect(content).not.toContain("<thinking_mode>");
      expect(content).not.toContain("<max_thinking_length>");
    });

    it("fast response emits no shim: content only, no thinking events", async () => {
      // Fast path: content arrives well before HIDDEN_REASONING_COUNTDOWN_MS.
      // The shim timer is cancelled on first content, so zero
      // thinking_* events fire — the response reads as plain text.
      vi.stubGlobal(
        "fetch",
        mockFetchOk('{"content":"Hi"}{"content":"!"}{"contextUsagePercentage":5}'),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));

      const types = events.map((e) => e.type);
      const startIdx = types.indexOf("start");
      const textStartIdx = types.indexOf("text_start");
      const textEndIdx = types.indexOf("text_end");
      const doneIdx = types.indexOf("done");

      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(textStartIdx).toBeGreaterThan(startIdx);
      expect(textEndIdx).toBeGreaterThan(textStartIdx);
      expect(doneIdx).toBeGreaterThan(textEndIdx);

      // No thinking_* events at all on fast responses.
      expect(types.filter((t) => t === "thinking_start")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_delta")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_end")).toHaveLength(0);

      const textStart = events.find((e) => e.type === "text_start");
      expect(textStart?.type === "text_start" && textStart.contentIndex).toBe(0);

      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        const msg: AssistantMessage = done.message;
        expect(msg.content).toHaveLength(1);
        const text = msg.content[0];
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(text.text).toBe("Hi!");
        }
      }
    });

    it("leaked <thinking> tags split into thinking + text blocks", async () => {
      // The ThinkingTagParser runs unconditionally — if Opus 4.7
      // leaks a tag through the adaptive-thinking policy, it's
      // parsed into a proper thinking block instead of rendered
      // verbatim as text.
      vi.stubGlobal(
        "fetch",
        mockFetchOk(
          '{"content":"<thinking>x</thinking>answer"}{"contextUsagePercentage":5}',
        ),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));
      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.message.content).toHaveLength(2);
        const thinking = done.message.content[0];
        expect(thinking?.type).toBe("thinking");
        if (thinking?.type === "thinking") {
          expect(thinking.thinking).toBe("x");
        }
        const text = done.message.content[1];
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(text.text).toBe("answer");
        }
      }
    });

    it("fast tool-call response emits no shim before tool events", async () => {
      // Fast path straight to a tool call — no content, no shim.
      // The shim timer is cancelled on the first tool event.
      const toolPayload =
        '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
      vi.stubGlobal(
        "fetch",
        mockFetchOk(`${toolPayload}{"contextUsagePercentage":5}`),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));

      const types = events.map((e) => e.type);
      const toolStartIdx = types.indexOf("toolcall_start");

      // No thinking_* events at all — tool call arrived before the
      // shim countdown could fire.
      expect(types.filter((t) => t === "thinking_start")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_delta")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_end")).toHaveLength(0);
      expect(toolStartIdx).toBeGreaterThan(types.indexOf("start"));

      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.reason).toBe("toolUse");
        expect(done.message.content[0]?.type).toBe("toolCall");
      }
    });

    it("slow response emits complete shim after countdown", async () => {
      // When nothing arrives within HIDDEN_REASONING_COUNTDOWN_MS,
      // the timer fires a complete shim (start + delta + end) in one
      // flush. Content that arrives afterwards lands at a later
      // contentIndex.
      let resolveFirst: ((value: { done: boolean; value?: Uint8Array }) => void) | undefined;
      const firstPromise = new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
        resolveFirst = res;
      });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockReturnValueOnce(firstPromise)
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const streamPromise = collect(
        streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }),
      );

      // Advance past the countdown threshold so the shim fires.
      await vi.advanceTimersByTimeAsync(HIDDEN_REASONING_COUNTDOWN_MS + 50);

      // Now resolve the reader with the actual payload.
      resolveFirst?.({
        done: false,
        value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}'),
      });

      const events = await streamPromise;
      vi.useRealTimers();

      // The shim is a complete start + delta + end triple at
      // contentIndex 0, all carrying the placeholder.
      const shimStart = events.find((e) => e.type === "thinking_start");
      const shimDelta = events.find((e) => e.type === "thinking_delta");
      const shimEnd = events.find((e) => e.type === "thinking_end");
      expect(shimStart?.type === "thinking_start" && shimStart.contentIndex).toBe(0);
      expect(shimDelta?.type === "thinking_delta" && shimDelta.contentIndex).toBe(0);
      expect(shimEnd?.type === "thinking_end" && shimEnd.contentIndex).toBe(0);
      if (shimDelta?.type === "thinking_delta") {
        expect(shimDelta.delta).toBe("Reasoning hidden by provider");
      }
      if (shimEnd?.type === "thinking_end") {
        expect(shimEnd.content).toBe("");
      }

      // Shim ordering: all three shim events precede text_start.
      const types = events.map((e) => e.type);
      const textStartIdx = types.indexOf("text_start");
      expect(types.indexOf("thinking_end")).toBeLessThan(textStartIdx);

      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        // Shim at [0], text at [1].
        expect(done.message.content).toHaveLength(2);
        const thinking = done.message.content[0];
        if (thinking?.type === "thinking") {
          expect(thinking.thinking).toBe("Reasoning hidden by provider");
          expect(thinking.redacted).toBe(true);
        }
        const text = done.message.content[1];
        if (text?.type === "text") {
          expect(text.text).toBe("Hi");
        }
      }
    }, 10000);

    it("cancels countdown when first content arrives before threshold", async () => {
      // Resolve the reader just under the countdown threshold so the
      // timer should be cancelled before it can fire the marker.
      let resolveFirst: ((value: { done: boolean; value?: Uint8Array }) => void) | undefined;
      const firstPromise = new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
        resolveFirst = res;
      });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockReturnValueOnce(firstPromise)
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const streamPromise = collect(
        streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }),
      );

      // Advance under the threshold then resolve content.
      await vi.advanceTimersByTimeAsync(HIDDEN_REASONING_COUNTDOWN_MS - 500);
      resolveFirst?.({
        done: false,
        value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}'),
      });

      // Advance past what would have been the firing time — nothing
      // should happen because the timer was cancelled on first content.
      await vi.advanceTimersByTimeAsync(HIDDEN_REASONING_COUNTDOWN_MS + 1000);

      const events = await streamPromise;
      vi.useRealTimers();

      // Shim timer was cancelled on first content → no thinking_*
      // events at all.
      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === "thinking_start")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_delta")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_end")).toHaveLength(0);

      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        // No thinking block — text at content[0].
        expect(done.message.content).toHaveLength(1);
        const text = done.message.content[0];
        if (text?.type === "text") {
          expect(text.text).toBe("Hi");
        }
      }
    }, 10000);

    it("terminal error cancels pending shim (no stray shim event)", async () => {
      // Stream error before the countdown would fire. The shim timer
      // is cancelled in the error handler; no thinking events fire.
      const errorBody = '{"error":"ThrottlingException","message":"Rate limit"}';
      const makeReader = () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(errorBody) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      const makeResponse = () => ({ ok: true, body: { getReader: makeReader } });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse())
        .mockResolvedValueOnce(makeResponse())
        .mockResolvedValueOnce(makeResponse())
        .mockResolvedValueOnce(makeResponse());
      vi.stubGlobal("fetch", fetchMock);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));
      vi.useRealTimers();

      const errIdx = events.findIndex((e) => e.type === "error");
      expect(errIdx).toBeGreaterThanOrEqual(0);

      // No thinking_* events anywhere in the error path — the shim
      // timer was cancelled cleanly without firing.
      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === "thinking_start")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_delta")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_end")).toHaveLength(0);
    }, 30000);
  });

  it("emits stream-level error when response body has error event", async () => {
    const errorBody = '{"error":"ThrottlingException","message":"Rate limit"}';
    // Stream error triggers outer-loop retries. Provide 4 identical responses
    // (initial + 3 retries) — after max retries, emits error.
    const makeReader = () => ({
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(errorBody) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn().mockResolvedValue(undefined),
    });
    const makeResponse = () => ({ ok: true, body: { getReader: makeReader } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse());
    vi.stubGlobal("fetch", fetchMock);

    // Speed up: stub setTimeout for the abortableDelay in retries
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.useRealTimers();

    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.error.errorMessage).toMatch(/ThrottlingException/);
    }
  }, 30000);
});
