# Changelog

## 0.1.4

- Fix: `ThinkingTagParser` runs unconditionally when `reasoning` is
  enabled. Previously gated on `!reasoningHidden` on the assumption
  that Anthropic's adaptive-thinking "omitted" policy was binding;
  it isn't — Opus 4.7 intermittently leaks `<thinking>...</thinking>`
  tags. Defensive parsing splits them into proper thinking blocks
  instead of rendering as raw tags in text. No-tag streams are a
  no-op (text-buffer scan).
- Change: the redacted-thinking breadcrumb now emits lazily. Previously
  pushed on `start` then possibly updated after a 2s countdown,
  leaving an empty thinking block at `content[0]` on every fast
  response — a representation bug downstream consumers worked around
  by filtering empty thinking blocks. Now: a 3s timer arms on `start`;
  if content or a tool call arrives first, the timer is cancelled and
  no shim is emitted; otherwise the full shim (`thinking_start` +
  `thinking_delta` with marker + `thinking_end`) flushes in one shot.
- `reasoningHidden` still controls: (a) skipping the `<thinking_mode>`
  system-prompt directive, (b) the lazy shim. It no longer gates the
  parser.
- Consumers that filtered empty redacted-thinking blocks
  (Inkstone, pi-coding-agent, OpenCode) see no user-visible change.
  Consumers that relied on the literal empty-shim breadcrumb at
  `content[0]` on fast responses should verify behavior.

## 0.1.3

- Drop `@mariozechner/pi-coding-agent` as a dependency and peer. pi-kiro
  used it only for the `ExtensionAPI` type; the minimal shape is now
  declared locally in `src/extension.ts`. Hosts on any pi version can
  install pi-kiro without a resolution error.
- Add `@mariozechner/pi-ai` `^0.72.1` as an explicit devDep (previously
  transitive via pi-coding-agent).
- `@mariozechner/pi-ai` stays declared as peer `*`.
- `ExtensionAPI` / `ProviderConfig` in the emitted `dist/extension.d.ts`
  are now local, not re-exported from pi-coding-agent. Consumers should
  keep importing these types from `@mariozechner/pi-coding-agent`
  directly; pi-kiro does not re-export them.
- Public API surface (`streamKiro`, `kiroModels`, `loginKiro`,
  `refreshKiroToken`, `resolveApiRegion`, `filterModelsByRegion`,
  `KiroCredentials`, `KiroModel`, etc.) is unchanged.
