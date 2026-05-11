// Standalone API for non-pi consumers.
//
// Import via: `import { loginKiro, streamKiro, ... } from "pi-kiro/core"`.
//
// The full pi extension lives at package root ("."). This subpath imports
// only @earendil-works/pi-ai (types + stream helpers), so apps embedding
// the Kiro provider into their own UI (e.g. an opentui frontend, a server
// backend) don't need pi-coding-agent installed.
//
// Sensitive data: `KiroCredentials` contains `clientSecret` and a `refresh`
// token that together can mint new access tokens for the user's AWS
// identity. Persist only to secure storage (OS keychain, encrypted file,
// HTTP-only cookie). Never log, never send to telemetry, never embed in
// URLs or query strings.

export {
	BUILDER_ID_REGION,
	BUILDER_ID_START_URL,
	loginKiro,
	refreshKiroToken,
} from "./oauth";
export type { KiroCredentials } from "./oauth";

export { streamKiro } from "./stream";

export {
	buildModelsFromApi,
	fetchAvailableModels,
	filterModelsByRegion,
	resolveApiRegion,
	resolveKiroModel,
} from "./models";
export type { KiroModelDef } from "./models";
