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

    it("fast response emits thinking_start/end with no delta", async () => {
      // Mirrors the captured 4.7 wire shape: plain text content frames only,
      // no <thinking> tags. In the test environment, mock reader resolves
      // synchronously so the first `content` event fires well under the
      // 2000ms countdown — no marker delta should be emitted.
      vi.stubGlobal(
        "fetch",
        mockFetchOk('{"content":"Hi"}{"content":"!"}{"contextUsagePercentage":5}'),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));

      // Event order: start → thinking_start → thinking_end →
      // text_start → text_delta+ → text_end → done. No thinking_delta.
      const types = events.map((e) => e.type);
      const startIdx = types.indexOf("start");
      const thinkingStartIdx = types.indexOf("thinking_start");
      const thinkingEndIdx = types.indexOf("thinking_end");
      const textStartIdx = types.indexOf("text_start");
      const textEndIdx = types.indexOf("text_end");
      const doneIdx = types.indexOf("done");

      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingStartIdx).toBeGreaterThan(startIdx);
      expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
      expect(textStartIdx).toBeGreaterThan(thinkingEndIdx);
      expect(textEndIdx).toBeGreaterThan(textStartIdx);
      expect(doneIdx).toBeGreaterThan(textEndIdx);

      // Zero thinking_delta events — fast path cancels the countdown
      // before the marker can fire.
      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingDeltas).toHaveLength(0);

      // Content indices: thinking block at 0, text block at 1.
      const ts = events.find((e) => e.type === "thinking_start");
      const te = events.find((e) => e.type === "thinking_end");
      expect(ts?.type === "thinking_start" && ts.contentIndex).toBe(0);
      expect(te?.type === "thinking_end" && te.contentIndex).toBe(0);
      if (te?.type === "thinking_end") {
        expect(te.content).toBe("");
      }

      const textStart = events.find((e) => e.type === "text_start");
      expect(textStart?.type === "text_start" && textStart.contentIndex).toBe(1);

      // Final message: empty redacted thinking block followed by text.
      // Clients drop the empty-thinking block via their existing
      // empty-text predicate (inkstone, pi-coding-agent, OpenCode).
      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        const msg: AssistantMessage = done.message;
        expect(msg.content).toHaveLength(2);
        const thinking = msg.content[0];
        expect(thinking?.type).toBe("thinking");
        if (thinking?.type === "thinking") {
          expect(thinking.thinking).toBe("");
          expect(thinking.redacted).toBe(true);
        }
        const text = msg.content[1];
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(text.text).toBe("Hi!");
        }
      }
    });

    it("does not pass content through ThinkingTagParser (literal tags preserved)", async () => {
      // If the parser were active, "<thinking>x</thinking>" would be stripped.
      // Under reasoningHidden it must reach the text block verbatim.
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
        const text = done.message.content.find((c) => c.type === "text");
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(text.text).toBe("<thinking>x</thinking>answer");
        }
        // Exactly one thinking block (the shim). Fast path → empty.
        const thinkingBlocks = done.message.content.filter((c) => c.type === "thinking");
        expect(thinkingBlocks).toHaveLength(1);
      }
    });

    it("fast response closes thinking before first tool call with no delta", async () => {
      // No preceding `content` frame — model goes straight to a tool call.
      // The block must close before any toolcall_* events. Fast path so
      // no marker delta fires.
      const toolPayload =
        '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
      vi.stubGlobal(
        "fetch",
        mockFetchOk(`${toolPayload}{"contextUsagePercentage":5}`),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));

      const types = events.map((e) => e.type);
      const thinkingStartIdx = types.indexOf("thinking_start");
      const thinkingEndIdx = types.indexOf("thinking_end");
      const toolStartIdx = types.indexOf("toolcall_start");

      expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
      expect(toolStartIdx).toBeGreaterThan(thinkingEndIdx);

      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingDeltas).toHaveLength(0);

      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.reason).toBe("toolUse");
        expect(done.message.content[0]?.type).toBe("thinking");
        expect(done.message.content[1]?.type).toBe("toolCall");
      }
    });

    it("slow response emits marker delta after countdown then closes empty", async () => {
      // Delay the first chunk past the 2000ms countdown. The countdown
      // should fire and emit the marker delta before the content arrives.
      // After content streams, thinking_end closes with empty content.
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

      // Advance past the countdown threshold. The timer callback runs
      // and emits the marker delta synchronously.
      await vi.advanceTimersByTimeAsync(HIDDEN_REASONING_COUNTDOWN_MS + 50);

      // Now resolve the reader with the actual payload.
      resolveFirst?.({
        done: false,
        value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}'),
      });

      const events = await streamPromise;
      vi.useRealTimers();

      // thinking_delta must appear, carry the placeholder, and precede
      // any text event.
      const deltaIdx = events.findIndex((e) => e.type === "thinking_delta");
      const textStartIdx = events.findIndex((e) => e.type === "text_start");
      expect(deltaIdx).toBeGreaterThanOrEqual(0);
      expect(deltaIdx).toBeLessThan(textStartIdx);

      const delta = events[deltaIdx];
      if (delta?.type === "thinking_delta") {
        expect(delta.delta).toBe("Reasoning hidden by provider");
        expect(delta.contentIndex).toBe(0);
      }

      // thinking_end closes with empty content regardless of whether
      // the marker fired — accumulated text lives on the block itself.
      const te = events.find((e) => e.type === "thinking_end");
      if (te?.type === "thinking_end") {
        expect(te.content).toBe("");
      }

      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        const thinking = done.message.content[0];
        if (thinking?.type === "thinking") {
          expect(thinking.thinking).toBe("Reasoning hidden by provider");
          expect(thinking.redacted).toBe(true);
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

      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
      expect(thinkingDeltas).toHaveLength(0);

      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        const thinking = done.message.content[0];
        if (thinking?.type === "thinking") {
          expect(thinking.thinking).toBe("");
        }
      }
    }, 10000);

    it("closes live indicator with empty content on terminal error", async () => {
      // Simulate an immediate stream error on every attempt. The terminal
      // error event must be preceded by a thinking_end with empty content
      // so downstream UIs don't hang with a live indicator.
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

      // Walk backward from `error` to find the last thinking_end.
      let lastThinkingEndIdx = -1;
      for (let i = errIdx - 1; i >= 0; i--) {
        if (events[i]?.type === "thinking_end") {
          lastThinkingEndIdx = i;
          break;
        }
      }
      expect(lastThinkingEndIdx).toBeGreaterThanOrEqual(0);
      const lastEnd = events[lastThinkingEndIdx];
      if (lastEnd?.type === "thinking_end") {
        expect(lastEnd.content).toBe("");
      }
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
