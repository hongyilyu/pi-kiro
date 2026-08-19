# Changelog

## 0.2.0

- **Dynamic Model Discovery**: Added `fetchAvailableKiroModels` to query the official `AmazonCodeWhispererService.ListAvailableModels` endpoint, dynamically fetching account-specific models with in-memory caching and resilient fallback.
- **Added Latest Models**:
  - **Claude Opus 5** (`claude-opus-5`, 1M context, 128k max tokens, reasoning support)
  - **Claude Opus 4.8** (`claude-opus-4-8`, 1M context, 128k max tokens)
  - **Claude Sonnet 5** (`claude-sonnet-5`, 1M context, 65k max tokens)
  - **OpenAI GPT-5.6 Series**: `gpt-5-6-sol`, `gpt-5-6-terra`, `gpt-5-6-luna`
  - **GLM-5** (`glm-5`, 200k context, 8k max tokens)
- **Forward Compatibility**: Relaxed `resolveKiroModel` to format arbitrary digit-dashed model IDs without crashing on unlisted model names.
- **New Core Exports**: Exported `fetchAvailableKiroModels`, `getCachedDynamicModels`, `clearDynamicModelCache`, `toPiModelId`, and related discovery types from `pi-kiro/core`.

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
