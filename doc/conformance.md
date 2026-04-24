# Conformance Checklist

Acceptance contract for pi-kiro. Each item is numbered; test files reference
item numbers in comments.

## Transform (pi → Kiro)

1. System prompt prepended to first user message, not sent as separate field.
   `systemPrepended: true` flag prevents double-prepend.
2. `modelId: kiroModelId` with dot format (e.g. `claude-sonnet-4.6`), converted
   from pi's dash format via `resolveKiroModel()`.
3. `origin: "KIRO_CLI"` literal on every `userInputMessage`.
4. Assistant `thinking` blocks serialized as `<thinking>...</thinking>` prefix
   to `content`.
5. Tool calls → `toolUses: [{name, toolUseId, input}]` on
   `assistantResponseMessage`. Empty/string `input` → `{}` via JSON.parse.
6. Tool results → `userInputMessageContext.toolResults` on the *user* side.
7. Tool result text truncated at `TOOL_RESULT_LIMIT = 250,000` chars with
   middle-ellipsis marker `[TRUNCATED]`.
8. Consecutive user messages merged into one `userInputMessage`.
9. Tool results merged into previous user message when adjacent.
10. Images → `{format, source:{bytes}}` where `format` is the part after
    `image/` in the mime type.
11. Tool specs → `{toolSpecification:{name, description, inputSchema:{json}}}`
    with `inputSchema.json` = raw pi `parameters`.
12. Error/aborted assistant messages filtered via `normalizeMessages()`.
13. Unpaired surrogates stripped via pi-mono's `sanitizeSurrogates`.

## History maintenance

14. Images stripped from historical entries only; current-turn images preserved.
15. Size-budgeted truncation: shift → sanitize → re-measure until under limit.
16. Limit scales with model context window:
    `Math.floor((contextWindow / 200_000) * 850_000)`.
17. Leading invalid entries stripped after truncation.
18. Empty assistant entries (no content, no toolUses) dropped.
19. Assistant toolUses without matching toolResult dropped.
20. Orphan toolResults without preceding toolUses dropped.

## Streaming request

21. Endpoint: `POST https://q.{region}.amazonaws.com/generateAssistantResponse`.
22. Headers exactly match kiro-cli / Amazon Q CLI:
    - `Content-Type: application/x-amz-json-1.0`
    - `Accept: application/json`
    - `Authorization: Bearer {access}`
    - `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
    - `x-amzn-codewhisperer-optout: true`
    - `amz-sdk-invocation-id: {uuid}`
    - `amz-sdk-request: attempt=1; max=1`
    - `x-amzn-kiro-agent-mode: vibe`
    - `x-amz-user-agent` / `user-agent`: `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-{hex32}`
23. Body structure:
    - `conversationState.chatTriggerType: "MANUAL"`
    - `conversationState.agentTaskType: "vibe"`
    - `conversationState.conversationId: sessionId ?? crypto.randomUUID()`
    - `conversationState.currentMessage.userInputMessage: {...}`
    - `conversationState.history?: KiroHistoryEntry[]` (omit if empty)
    - `profileArn?: string` (omit if unresolved)
    - `agentMode: "vibe"` at top level
24. profileArn resolved via `AmazonCodeWhispererService.ListAvailableProfiles`,
    cached per endpoint. Re-resolved after 403 refresh.
25. Truncation continuation notice prepended when prior assistant message had
    `stopReason: "length"`.
26. Thinking mode injects
    `<thinking_mode>enabled</thinking_mode><max_thinking_length>{N}</max_thinking_length>`
    into the system prompt where N = 10k/20k/30k/50k based on reasoning level.
    Skipped when `model.reasoningHidden` is true (directive is a no-op there).
26a. Models with `reasoningHidden: true` emit a redacted `ThinkingContent`
    block. `thinking_start` fires immediately after `start` and opens a
    2-second countdown. If the first real output event (`content` or
    `toolUse`) arrives before the countdown elapses, the block closes with
    zero `thinking_delta` events and `thinking_end.content === ""` — fast
    paths produce an empty redacted block that every pi-ai-compatible UI
    drops via its existing empty-text predicate. If the countdown elapses
    first, a single `thinking_delta` carrying `"Reasoning hidden by
    provider"` is emitted as a user-visible status during the wait; the
    block still closes with `thinking_end.content === ""` once real output
    begins, and `output.content[i].thinking` carries the placeholder for
    post-hoc inspection. Retry and terminal-error paths always cancel the
    countdown before closing. Applies to Claude Opus 4.7 (Anthropic's
    adaptive-thinking defaults `display` to `"omitted"` for 4.7+, so no
    reasoning text reaches the wire). `ThinkingTagParser` is disabled for
    these models — literal tag strings in text pass through verbatim.
    See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking

## Stream response

27. Events parsed via brace-balanced JSON extraction with incremental buffering.
    Event types: `content`, `toolUse`, `toolUseInput`, `toolUseStop`,
    `contextUsage`, `usage`, `error`, `followupPrompt` (ignored).
28. Thinking tag variants `<thinking>`, `<think>`, `<reasoning>`, `<thought>`
    recognized and split from text (streaming-safe across chunks).
29. If thinking arrives after text, thinking block spliced before text block.
30. Tool call `input` defaults to `"{}"` when empty.
31. Duplicate `content` events deduped by exact-match comparison.
32. `contextUsagePercentage` → `usage.input`:
    `Math.round((pct/100) * contextWindow)`; `contextPercent` exposed on usage.
33. Output tokens: prefer `usage.outputTokens` event; fall back to
    `countTokens(totalContent)` using a `Math.ceil(length / 4)` heuristic
    (~4 chars/token). Approximation only — diverges from real BPE for code
    and CJK/emoji text; feeds cost reporting on the fallback path.
34. `calculateCost(model, usage)` from pi-mono. Fallback to zeros on error.

## Stop reason

35. `toolUse` when `emittedToolCalls > 0`.
36. `length` when no `contextUsage` event received AND no tool calls.
37. `stop` otherwise.

## Retry / error handling

38. 413 or `CONTENT_LENGTH_EXCEEDS_THRESHOLD` / `Input is too long` /
    `Improperly formed` → throw with `context_length_exceeded` prefix.
39. `MONTHLY_REQUEST_COUNT` in body → throw immediately, no retry.
40. `INSUFFICIENT_MODEL_CAPACITY` → inner-loop retry with 5s/10s/20s backoff,
    max 3 retries.
41. 403 (non-capacity) → refresh token, re-resolve profileArn, outer-loop
    retry, max 3, 500ms base backoff.
42. First-token timeout (90s default, per-model override) → retry outer loop
    (max 3).
43. Idle timeout (300s rolling between reads) → retry outer loop.
44. Empty response (no text + no tool calls) → retry outer loop (max 3).
45. Stream-level `error` event → retry outer loop, max 3.
46. Abort signal honored at every await point. Surfaces as
    `stopReason: "aborted"`.

## OAuth / credentials

47. Device-code flow with standard AWS SSO-OIDC endpoints (us-east-1 only
    for Builder ID).
48. Refresh via `POST {oidcEndpoint}/token` with
    `{clientId, clientSecret, refreshToken, grantType: "refresh_token"}`.
49. Expiry buffer: 5 min subtracted from returned `expiresIn`.
50. Refresh packs pipe-format:
    `{refreshToken}|{clientId}|{clientSecret}|idc`.
