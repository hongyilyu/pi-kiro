// Kiro streaming orchestrator. Builds the CodeWhisperer request, enforces
// retry/timeout policies, and translates Kiro's JSON event stream into pi's
// AssistantMessageEvent protocol.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { log, previewChunk } from "./debug";
import { parseKiroEvents } from "./event-parser";
import type { KiroModel } from "./models";
import { kiroModels, resolveKiroModel } from "./models";
import { ThinkingTagParser } from "./thinking-parser";
import { countTokens } from "./tokenizer";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  extractImages,
  getContentText,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  parseToolArgs,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform";

// ---- Retry / timeout constants -----------------------------------------

const FIRST_TOKEN_TIMEOUT_DEFAULT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

const CAPACITY_MAX_RETRIES = 3;
const CAPACITY_BASE_DELAY_MS = 5_000;
const CAPACITY_MAX_DELAY_MS = 30_000;

const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";

function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function isTooBigError(status: number, body: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => body.includes(p)));
}

function isNonRetryableBodyError(body: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => body.includes(p));
}

function isCapacityError(body: string): boolean {
  return body.includes(CAPACITY_PATTERN);
}

function firstTokenTimeoutForModel(modelId: string): number {
  const m = kiroModels.find((x) => x.id === modelId) as KiroModel | undefined;
  return m?.firstTokenTimeout ?? FIRST_TOKEN_TIMEOUT_DEFAULT_MS;
}

/**
 * Placeholder surfaced to downstream UIs during the deliberation window
 * on models that hide reasoning (e.g. Claude Opus 4.7 with
 * adaptive-thinking `display: "omitted"`). Emitted as a `thinking_delta`
 * only after the countdown elapses without any real output — fast
 * responses produce no delta at all. Clients drop the block at
 * `thinking_end` either via the empty-text predicate (zero-delta fast
 * path) or via a known-placeholder predicate (slow path).
 */
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider";

/**
 * How long to wait after `thinking_start` before emitting the user-visible
 * marker delta. Shorter than a typical user's "is this hung?" threshold so
 * the marker appears exactly when the wait starts feeling palpable, but
 * long enough that fast responses never flash the marker.
 */
export const HIDDEN_REASONING_COUNTDOWN_MS = 2000;

/**
 * Open a redacted ThinkingContent block at the start of the stream. The
 * block begins with empty `thinking` text so every pi-ai-compatible UI
 * treats it as a live indicator. The block is either closed empty (fast
 * path) or has `emitHiddenReasoningMarker` mutate it mid-stream (slow
 * path) before closing.
 *
 * Returns the `contentIndex` of the pushed block.
 */
function emitHiddenReasoningStart(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): number {
  const contentIndex = output.content.length;
  const block: ThinkingContent = {
    type: "thinking",
    thinking: "",
    redacted: true,
  };
  output.content.push(block);
  stream.push({ type: "thinking_start", contentIndex, partial: output });
  return contentIndex;
}

/**
 * Populate an open redacted-thinking block with the placeholder marker.
 * Fires from the countdown timer when the first real output event hasn't
 * arrived within `HIDDEN_REASONING_COUNTDOWN_MS`. Mutates the block in
 * place and emits a single `thinking_delta` so UIs that render accumulated
 * thinking text (inkstone, pi-coding-agent) display the marker until
 * `thinking_end` arrives.
 */
function emitHiddenReasoningMarker(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  contentIndex: number,
): void {
  const block = output.content[contentIndex];
  if (block && block.type === "thinking") {
    block.thinking = HIDDEN_REASONING_PLACEHOLDER;
  }
  stream.push({
    type: "thinking_delta",
    contentIndex,
    delta: HIDDEN_REASONING_PLACEHOLDER,
    partial: output,
  });
}

/**
 * Close a block previously opened by `emitHiddenReasoningStart`. Always
 * emits `thinking_end` with empty content — the accumulated text (if any)
 * lives on `output.content[contentIndex].thinking`. UIs that drop
 * redacted-thinking blocks do so either via an empty-text check or via a
 * known-placeholder predicate; both shapes work with empty `content`.
 */
function closeHiddenReasoning(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  contentIndex: number,
): void {
  stream.push({
    type: "thinking_end",
    contentIndex,
    content: "",
    partial: output,
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// ---- profileArn cache --------------------------------------------------

const profileArnCache = new Map<string, string>();
/**
 * When true, `resolveProfileArn` is a no-op. Tests that don't mock the
 * ListAvailableProfiles endpoint flip this on to avoid firing a real request.
 */
let profileArnSkipResolution = false;

/**
 * Reset cache state. Pass `skipResolution: true` to disable profileArn lookup
 * entirely (useful for tests that don't mock ListAvailableProfiles).
 * Production code should never pass true — cache is reset on logout/refresh
 * without disabling resolution.
 */
export function resetProfileArnCache(skipResolution = false): void {
  profileArnCache.clear();
  profileArnSkipResolution = skipResolution;
}

async function resolveProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  if (profileArnSkipResolution) return undefined;
  const cached = profileArnCache.get(endpoint);
  if (cached !== undefined) return cached;

  try {
    const ep = new URL(endpoint);
    ep.pathname = ep.pathname.replace(/\/generateAssistantResponse\/?$/, "/");
    ep.search = "";
    ep.hash = "";

    const resp = await fetch(ep.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      },
      body: "{}",
    });
    if (!resp.ok) {
      log.warn(`profileArn resolution failed: ${resp.status} ${resp.statusText}`);
      return undefined;
    }
    const j = (await resp.json()) as { profiles?: Array<{ arn?: string }> };
    const arn = j.profiles?.find((p) => p.arn)?.arn;
    if (!arn) {
      log.warn("profileArn resolution returned no profile ARN");
      return undefined;
    }
    profileArnCache.set(endpoint, arn);
    return arn;
  } catch (error) {
    log.warn(`profileArn resolution threw: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// ---- Request body shape ------------------------------------------------

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
  agentMode?: string;
}

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): boolean {
  if (!state.input.trim()) state.input = "{}";

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
  } catch (e) {
    log.warn(
      `failed to parse tool input for "${state.name}" (${state.toolUseId}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: state.input, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return true;
}

// ---- Main entry --------------------------------------------------------

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Live index of the currently-open redacted-thinking block, if any.
    // Hoisted above the try/catch so the terminal error path can close it
    // to prevent downstream UIs from hanging on an orphan live indicator.
    let hiddenThinkingIndex: number | null = null;
    // Countdown timer that emits the user-visible marker delta if the
    // first real output event doesn't arrive within
    // HIDDEN_REASONING_COUNTDOWN_MS of `thinking_start`. Hoisted alongside
    // `hiddenThinkingIndex` so every exit path can cancel it.
    let hiddenMarkerTimer: ReturnType<typeof setTimeout> | null = null;
    let hiddenMarkerEmitted = false;

    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error("Kiro credentials not set. Run /login kiro.");
      }

      const endpoint = model.baseUrl || "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
      const profileArn = await resolveProfileArn(accessToken, endpoint);
      const kiroModelId = resolveKiroModel(model.id);
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      // Kiro models where upstream hides reasoning entirely (no `<thinking>`
      // tags in the text stream, no native reasoning event). We surface a
      // redacted ThinkingContent shim so downstream UIs can show a
      // "reasoning hidden" marker via the standard pi-ai contract.
      const reasoningHidden = !!(model as KiroModel).reasoningHidden;

      log.debug("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        reasoningHidden,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });

      let systemPrompt = context.systemPrompt ?? "";
      // Skip the `<thinking_mode>` directive when the provider hides
      // reasoning — the directive is a no-op there and costs prompt tokens.
      if (thinkingEnabled && !reasoningHidden) {
        const budget =
          options?.reasoning === "xhigh"
            ? 50000
            : options?.reasoning === "high"
              ? 30000
              : options?.reasoning === "medium"
                ? 20000
                : 10000;
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${
          systemPrompt ? `\n${systemPrompt}` : ""
        }`;
      }

      const conversationId = options?.sessionId ?? crypto.randomUUID();
      let retryCount = 0;

      while (retryCount <= MAX_RETRIES) {
        if (options?.signal?.aborted) throw options.signal.reason;

        const normalized = normalizeMessages(context.messages);
        const {
          history,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, systemPrompt);

        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;

        if (firstMsg?.role === "assistant") {
          const am = firstMsg;
          let armContent = "";
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content)) {
            for (const b of am.content) {
              if (b.type === "text") {
                armContent += (b as TextContent).text;
              } else if (b.type === "thinking") {
                armContent = `<thinking>${(b as unknown as { thinking: string }).thinking}</thinking>\n\n${armContent}`;
              } else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: tc.id,
                  input: parseToolArgs(tc.arguments),
                });
              }
            }
          }
          if (armContent || armToolUses.length > 0) {
            const last = history[history.length - 1];
            if (last && !last.userInputMessage && last.assistantResponseMessage) {
              last.assistantResponseMessage.content += `\n\n${armContent}`;
              if (armToolUses.length > 0) {
                last.assistantResponseMessage.toolUses = [
                  ...(last.assistantResponseMessage.toolUses ?? []),
                  ...armToolUses,
                ];
              }
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                },
              });
            }
          }

          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages: ImageContent[] = [];
          for (const m of currentMessages) {
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (systemPrompt && !systemPrepended) {
            currentContent = `${systemPrompt}\n\n${currentContent}`;
          }
        }

        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        if (currentToolResults.length > 0 || (context.tools && context.tools.length > 0)) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (context.tools?.length) {
            uimc.tools = convertToolsToKiro(context.tools);
          }
        }

        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs);
        }

        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: currentContent,
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                ...(uimc ? { userInputMessageContext: uimc } : {}),
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          ...(profileArn ? { profileArn } : {}),
          agentMode: "vibe",
        };

        // -- HTTP request with capacity-retry inner loop -----------------
        // Emit `start` and the hidden-reasoning indicator *before* the
        // fetch so the live indicator covers the server-side deliberation
        // window (which is where the 25-30s wait actually happens on
        // Claude 4.7 — the model reasons before sending any bytes).
        stream.push({ type: "start", partial: output });
        if (reasoningHidden && thinkingEnabled && hiddenThinkingIndex === null) {
          hiddenThinkingIndex = emitHiddenReasoningStart(output, stream);
          hiddenMarkerEmitted = false;
          const idx = hiddenThinkingIndex;
          hiddenMarkerTimer = setTimeout(() => {
            hiddenMarkerTimer = null;
            if (hiddenThinkingIndex === idx && !hiddenMarkerEmitted) {
              emitHiddenReasoningMarker(output, stream, idx);
              hiddenMarkerEmitted = true;
            }
          }, HIDDEN_REASONING_COUNTDOWN_MS);
        }

        let response!: Response;
        let capacityRetryCount = 0;
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;

          log.debug("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
          });

          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.0",
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
              "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
              "x-amzn-codewhisperer-optout": "true",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=1",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amz-user-agent": ua,
              "user-agent": ua,
            },
            body: JSON.stringify(request),
            signal: options?.signal,
          });

          if (response.ok) break;

          let errText = "";
          try {
            errText = await response.text();
          } catch {
            errText = "";
          }
          log.debug("response.error", { status: response.status, body: errText });

          if (isCapacityError(errText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
            capacityRetryCount++;
            const delayMs = exponentialBackoff(
              capacityRetryCount - 1,
              CAPACITY_BASE_DELAY_MS,
              CAPACITY_MAX_DELAY_MS,
            );
            log.warn(
              `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${CAPACITY_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            continue;
          }

          if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
            throw new Error(`Kiro API error: ${errText || response.statusText}`);
          }
          if (isTooBigError(response.status, errText)) {
            throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
          }
          if (response.status === 403) {
            // Access token was accepted earlier (profileArn resolved) but is
            // now rejected — drift, revocation, or server-side invalidation.
            // Bust the profileArn cache so the next attempt re-resolves with
            // a fresh token, and surface a clear re-login hint.
            profileArnCache.delete(endpoint);
            throw new Error(
              `Kiro API error: access token rejected (403) — run /login kiro to re-authenticate. ${errText}`,
            );
          }
          throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
        }

        if (capacityRetryCount > 0) {
          log.info(`recovered from capacity pressure after ${capacityRetryCount} retries`);
        }

        // -- Consume response stream -------------------------------------
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let lastContentData = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        let chunkSeq = 0;
        let eventSeq = 0;

        // ThinkingTagParser is disabled for reasoningHidden models since
        // no `<thinking>` tags will ever appear in the stream.
        const thinkingParser =
          thinkingEnabled && !reasoningHidden ? new ThinkingTagParser(output, stream) : null;
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        let currentToolCall: KiroToolCallState | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          currentToolCall = null;
        };

        /** Cancel the countdown timer without closing the block. */
        const cancelHiddenMarkerTimer = () => {
          if (hiddenMarkerTimer) {
            clearTimeout(hiddenMarkerTimer);
            hiddenMarkerTimer = null;
          }
        };

        /**
         * Close the hidden-reasoning block before the first real
         * content/tool event is emitted (happy path) or on stream end
         * (defensive). Cancels the countdown timer, emits `thinking_end`
         * with empty content, and sets `hiddenThinkingIndex = null` so
         * subsequent events don't try to close an already-closed block.
         *
         * The accumulated `thinking` text (if the countdown fired) lives
         * on `output.content[contentIndex].thinking` — downstream UIs
         * either drop the block via an empty-text predicate (fast path)
         * or via a known-placeholder predicate (slow path).
         */
        const closeHiddenBreadcrumb = () => {
          cancelHiddenMarkerTimer();
          if (hiddenThinkingIndex !== null) {
            closeHiddenReasoning(output, stream, hiddenThinkingIndex);
            hiddenThinkingIndex = null;
          }
        };

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, IDLE_TIMEOUT_MS);
        };

        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        type ReadResult = { done: boolean; value?: Uint8Array };

        while (true) {
          let readResult: ReadResult;
          if (!gotFirstToken) {
            const readPromise = reader.read() as Promise<ReadResult>;
            let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) => {
                firstTokenTimer = setTimeout(
                  () => resolve(FIRST_TOKEN_SENTINEL),
                  firstTokenTimeoutForModel(model.id),
                );
              }),
            ]);
            // Always clear the timer — otherwise the happy path keeps the
            // event loop alive for firstTokenTimeout ms after the stream
            // ends, which for opus-4-7 (180s) is user-visible as a hang
            // before a short-lived CLI exits.
            if (firstTokenTimer) clearTimeout(firstTokenTimer);
            if (result === FIRST_TOKEN_SENTINEL) {
              readPromise.catch(() => {});
              void reader.cancel().catch(() => {});
              firstTokenTimedOut = true;
              break;
            }
            readResult = result as ReadResult;
            gotFirstToken = true;
            resetIdle();
          } else {
            readResult = (await reader.read()) as ReadResult;
          }

          const { done, value } = readResult;
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
          if (log.isDebug()) {
            log.debug("stream.chunk", {
              seq: chunkSeq++,
              bytes: value?.byteLength ?? 0,
              decodedLen: decoded.length,
              // Printable preview of the decoded chunk — control chars shown as \xNN.
              preview: previewChunk(decoded),
            });
          }
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          resetIdle();

          if (log.isDebug() && events.length > 0) {
            for (const ev of events) {
              log.debug("stream.event", { seq: eventSeq++, event: ev });
            }
          }

          for (const event of events) {
            switch (event.type) {
              case "contextUsage": {
                const pct = event.data.contextUsagePercentage;
                output.usage.input = Math.round((pct / 100) * model.contextWindow);
                receivedContextUsage = true;
                break;
              }
              case "content": {
                if (event.data === lastContentData) continue;
                lastContentData = event.data;
                totalContent += event.data;
                // Close the live indicator before the first real text so
                // the breadcrumb finalizes adjacent to — not overlapping —
                // the text block.
                closeHiddenBreadcrumb();
                if (thinkingParser) {
                  thinkingParser.processChunk(event.data);
                } else {
                  if (textBlockIndex === null) {
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  const block = output.content[textBlockIndex] as TextContent | undefined;
                  if (block) {
                    block.text += event.data;
                    stream.push({
                      type: "text_delta",
                      contentIndex: textBlockIndex,
                      delta: event.data,
                      partial: output,
                    });
                  }
                }
                break;
              }
              case "toolUse": {
                const tc = event.data;
                // Close the live indicator before any tool-call events so
                // the breadcrumb finalizes above the tool execution.
                closeHiddenBreadcrumb();
                sawAnyToolCalls = true;
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                  flushToolCall();
                  currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
                }
                currentToolCall.input += tc.input || "";
                if (tc.input) totalContent += tc.input;
                if (tc.stop) flushToolCall();
                break;
              }
              case "toolUseInput": {
                if (currentToolCall) currentToolCall.input += event.data.input || "";
                if (event.data.input) totalContent += event.data.input;
                break;
              }
              case "toolUseStop": {
                if (event.data.stop) flushToolCall();
                break;
              }
              case "usage": {
                usageEvent = event.data;
                break;
              }
              case "error": {
                streamError = event.data.message
                  ? `${event.data.error}: ${event.data.message}`
                  : event.data.error;
                void reader.cancel().catch(() => {});
                break;
              }
            }
            if (streamError) break;
          }
        }

        if (idleTimer) clearTimeout(idleTimer);

        if (firstTokenTimedOut || idleCancelled || streamError) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(
              `stream ${firstTokenTimedOut ? "first-token timed out" : idleCancelled ? "idle timed out" : `error: ${streamError}`} — retrying (${retryCount}/${MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, options?.signal);
            // Close any open live indicator (cancels the countdown timer
            // and emits thinking_end with empty content) so the retry can
            // open a fresh block at contentIndex 0. pi-agent-core's
            // indexed assignment overwrites the prior block on the new
            // thinking_start, keeping consumer state in sync.
            closeHiddenBreadcrumb();
            // Reset output content. Consumer-side `partial.content[contentIndex]`
            // (see pi-agent-core proxy.js) uses indexed assignment, so when the
            // retry re-emits `text_start` at contentIndex 0 it overwrites the
            // stale block — consumer state stays in sync with ours.
            output.content = [];
            textBlockIndex = null;
            continue;
          }
          if (streamError) throw new Error(`Kiro API stream error after max retries: ${streamError}`);
          throw new Error(
            `Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`,
          );
        }

        // Stream ended cleanly. If we saw any real output, close the
        // block now. If not, defer until we know whether we'll retry so
        // terminal-empty responses still close the block exactly once.
        const gotAnyOutput = lastContentData !== "" || sawAnyToolCalls;
        if (gotAnyOutput) {
          closeHiddenBreadcrumb();
        }

        if (currentToolCall && emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }

        if (textBlockIndex !== null) {
          const block = output.content[textBlockIndex] as TextContent | undefined;
          if (block) {
            stream.push({
              type: "text_end",
              contentIndex: textBlockIndex,
              content: block.text,
              partial: output,
            });
          }
        }

        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          calculateCost(model, output.usage);
        } catch {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }

        const textBlock =
          textBlockIndex !== null
            ? (output.content[textBlockIndex] as TextContent | undefined)
            : undefined;
        const hasText = !!textBlock && textBlock.text.length > 0;
        if (!hasText && !sawAnyToolCalls) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            log.warn(`empty response — retrying (${retryCount}/${MAX_RETRIES})`);
            // Close the still-open block (gotAnyOutput was false above,
            // so the block is still open here). Cancels the countdown
            // timer and emits thinking_end with empty content.
            closeHiddenBreadcrumb();
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          log.warn(`empty response persisted after ${MAX_RETRIES} retries`);
          // No retries left — close the block so downstream doesn't hang
          // on an orphan open thinking_start.
          closeHiddenBreadcrumb();
        }

        // Stop reason classification per doc/conformance.md §35–37:
        // toolUse when tools were called; length when no contextUsage event
        // was received AND no tool calls (treated as truncation signal); stop
        // otherwise.
        if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }

        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        log.debug("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          usage: output.usage,
        });
        stream.end();
        return;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      log.debug("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      // Close any still-open live-indicator block before the error event.
      // Cancels the countdown timer (if still pending) so no stray
      // thinking_delta fires after the stream ends, and emits
      // thinking_end so downstream UIs don't hang on an orphan
      // thinking_start. The block's accumulated text (if the countdown
      // fired) stays on output.content[i].thinking for history/export.
      if (hiddenMarkerTimer) {
        clearTimeout(hiddenMarkerTimer);
        hiddenMarkerTimer = null;
      }
      if (hiddenThinkingIndex !== null) {
        closeHiddenReasoning(output, stream, hiddenThinkingIndex);
        hiddenThinkingIndex = null;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    try {
      stream.end();
    } catch {
      // ignore
    }
  });

  return stream;
}
