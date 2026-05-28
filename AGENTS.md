# Project Guidelines

## Project Shape
- This is a small Express + vanilla JavaScript realtime voice/text demo. See [README.md](README.md) for the user-facing overview and setup notes.
- Server responsibilities live in [server/index.js](server/index.js): read JSON config, apply `RT_*` environment overrides, create realtime sessions, resolve Azure/OpenAI endpoints, serve static assets, and persist MCP settings.
- Browser responsibilities live in [public/app.js](public/app.js): hydrate safe config, create WebSocket or WebRTC connections, send realtime events, handle audio/text deltas, local STT, latency logging, and MCP tool payloads.
- Configuration is JSON based: [config/config.json](config/config.json) for realtime/server settings and [config/mcp_config.json](config/mcp_config.json) for MCP tool settings. Treat config values as local development state and never reveal or copy secrets from them.

## Commands
- Install dependencies: `npm install`
- Run locally: `npm run dev` or `./start.sh`
- Production start: `npm start`
- There is currently no test script in `package.json`; when changing behavior, validate by starting the server and exercising the affected WebSocket/WebRTC path in the browser.

## Realtime Auth And Model Conventions
- Keep authentication mode explicit and server owned. Support both Azure managed identity/Entra token mode and API key mode; prefer managed identity for production and keep key mode as a local/dev fallback.
- Do not expose long-lived API keys to the browser. `/api/realtime-ws-key` is a local debugging helper; production-oriented changes should use server-created ephemeral credentials, a server proxy, or Entra-backed server calls.
- `realtime.authMode` is the server-side switch for Azure auth behavior. Keep `/api/realtime-session` compatible with both `api-key` and `managed-identity`, but do not extend `/api/realtime-ws-key` beyond its current dev-only API key scope unless the task explicitly requires it.
- For Azure API key mode, use the `api-key` request header for server-side session creation. For managed identity/Entra mode, use `Authorization: Bearer <token>` from the server-side credential flow.
- Keep provider branching centralized in the existing helpers (`isAzure()`, `resolveEndpoint()`, and auth construction) instead of scattering endpoint or header logic through the client.
- Treat Azure `deployment` and realtime `model` as configurable values. Do not hardcode `gpt-realtime`; changes must remain compatible with `gpt-realtime-2` and `gpt-realtime-translate` as deployment/model names.
- Preserve the existing GA/preview path handling unless replacing it with a verified newer API contract. Azure GA currently uses `/openai/v1/realtime/sessions`; preview uses `/openai/realtimeapi/sessions` with `api-version`.
- Be careful with fields that have caused `unknown_parameter` errors. The app currently suppresses model-side `input_audio_transcription` and turn detection payloads in some paths; re-enable only after checking the target model/API version.

## Implementation Notes
- Keep environment overrides in sync with `start.sh` and the startup override block in [server/index.js](server/index.js); prefer `RT_*` variables for runtime changes. The current auth/model overrides are `RT_AUTH_MODE`, `RT_MODEL`, `RT_DEPLOYMENT`, `RT_AZURE_CLIENT_ID`, and `RT_AZURE_AUTH_SCOPE`.
- Keep frontend session updates minimal and adaptive. The current client probes multiple `response.create` payload shapes to survive API drift.
- MCP tools are built from sanitized config and injected as session `tools`; avoid sending both an `authorization` property and duplicate `Authorization` header unless the target API explicitly requires it.
- When adding new config options, expose only safe fields through `/api/realtime-config` and document the corresponding environment override if one exists.