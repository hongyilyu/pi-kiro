# pi-kiro

[Kiro](https://kiro.dev) provider for [pi](https://github.com/badlogic/pi-mono).

Adds the Kiro model family (AWS Builder ID login, CodeWhisperer streaming API)
to pi's coding agent.

## Install

```bash
pi install pi-kiro
```

## Login

```bash
pi /login kiro
```

Two methods are supported:

- **AWS Builder ID** — leave the prompt blank. Opens the standard Builder ID
  device-authorization page.
- **IAM Identity Center (IdC / SSO)** — paste your company start URL
  (e.g. `https://mycompany.awsapps.com/start`). You can supply a specific
  AWS region or leave it blank to auto-detect.

Tokens are stored in `~/.pi/agent/auth.json`.

## Supported models

All Claude models available through the Kiro service, including:

- `claude-sonnet-4-5`
- `claude-sonnet-4-6`
- `claude-opus-4-7`

Run `pi --list-models` for the full list once the extension is loaded.

## Region support

Region is inferred from your Builder ID profile. Kiro API regions currently
available: `us-east-1`, `eu-central-1`, and others. See `src/models.ts` for
the authoritative region-to-model map.

## Development

```bash
bun install
bun run typecheck
bun run test
```

## Using outside pi (standalone)

The provider logic (OAuth + streaming) is also exposed at `pi-kiro/core` so
you can embed it into your own UI — e.g. an [opentui](https://github.com/sst/opentui)
frontend, a backend service, or a custom CLI — without pulling
`pi-coding-agent`.

```ts
import {
  loginKiro,
  refreshKiroToken,
  streamKiro,
  kiroModels,
  type KiroCredentials,
} from "pi-kiro/core";

// 1. Login. Your app implements pi-ai's OAuthLoginCallbacks (onPrompt,
//    onAuth, onProgress, signal) however it wants — a TUI dialog, a web
//    modal, stdin, etc.
const creds: KiroCredentials = await loginKiro({
  onPrompt: async ({ message }) => await myUi.ask(message),
  onAuth: ({ url, instructions }) => myUi.showDeviceCode(url, instructions),
  onProgress: (msg) => myUi.setStatus(msg),
  signal: abortController.signal,
});

// 2. Persist `creds` in secure storage. `creds.clientSecret` and
//    `creds.refresh` are sensitive — treat them like passwords. Call
//    refreshKiroToken(creds) when `Date.now() > creds.expires`.

// 3. Stream a turn. streamKiro(model, context, options?) returns an
//    AssistantMessageEventStream that's both async-iterable for events
//    and awaitable via .result() for the final AssistantMessage.
const model = kiroModels[0];
const stream = streamKiro(
  model,
  {
    messages: [
      { role: "user", content: "hello", timestamp: Date.now() },
    ],
  },
  { apiKey: creds.access },
);

for await (const event of stream) {
  // event.type: "start" | "text_delta" | "toolcall_start" | ... | "done" | "error"
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

const finalMessage = await stream.result();
```

Only `@mariozechner/pi-ai` is required at runtime for this path.

### Requirements

- **Published `dist/`** is plain ESM JavaScript with `.d.ts` files. Any
  Node >= 20 or bundler (Vite, webpack, esbuild) that supports ESM works.
- **From source** (e.g. if you're importing `./src/core` from a monorepo
  sibling) you need Bun, or Node with a TS loader (tsx, ts-node), or a
  bundler — the source is TypeScript with no file extensions on relative
  imports.

## License

MIT
