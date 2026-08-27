# @lj/dsh-openai-api

OpenAI-compatible HTTP surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). After this plugin is installed into a dsh profile, the harness web server additionally serves:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | Chat Completions API (streaming and non-streaming), including function/tool calling |
| `POST /v1/responses` | Responses API subset (streaming and non-streaming), stateless plus a `previous_response_id` continuation cache |
| `GET /v1/models` | Model catalog aggregated across registered providers |

Generation is served by the harness `llm` runtime: requests are answered with whichever provider/model your deployment has configured (the Models settings page writes it; `agentDefaultModel.currentSelection()` reads it).

## Install

From any machine:

```sh
# from GitHub
dsh plugin --profile web add github:huyang2024/dsh-openai-api

# or from a local checkout
dsh plugin --profile web add file:/absolute/path/to/dsh-openai-api
```

Then compose an insert for it in the profile's user patch layer — `$DSH_HOME/profiles/web/cordis.patch.yml`. New rows reach the tree only through `insert:`; a bare `{id, name}` entry would be treated as an override of a lower layer and skipped:

```yaml
- insert:
    - id: openai-api
      name: '@lj/dsh-openai-api'
      inject: [webServer]
      config:
        apiKey: ''            # optional Bearer key; empty keeps loopback-only access
        pathPrefix: '/v1'     # optional, this default shown
        maxBodyBytes: 33554432
        allowedOrigins: []    # extra exact origins allowed cross-origin
```

Restart the profile so the new row activates.

## Authentication and trust

- With `apiKey` set, every call must present `Authorization: Bearer <key>` (constant-time comparison).
- Without `apiKey`, only loopback callers are served; remote callers get `403 unauthorized_remote`, so an accidental LAN bind never exposes unauthenticated model access.
- Browser cross-origin calls from other origins are rejected unless listed in `allowedOrigins` or authenticated with a valid key. Same-origin pages pass through. Preflight `OPTIONS` is answered on all three paths.

## Model routing

The request's `model` field resolves as:

1. Exact `"provider/model"` pair when the provider route exists.
2. An id found in some registered provider's catalog (60 s advisory cache).
3. Otherwise passed verbatim to the default provider selection.

Omitted `model` uses the deployment default unchanged.

## Request support notes

Chat Completions: `messages` (`system`/`developer`/`user`/`assistant`/`tool`), string or typed-part content, `tools` + tool-call round-trips (`tool_calls` ↔ `role:'tool'` results), `temperature`, `max_tokens`/`max_completion_tokens`, `stop` (≤ 4), `stream`, `stream_options.include_usage`, `n = 1`. Streaming deltas carry `reasoning_content` (DeepSeek-style) when the provider emits reasoning.

Responses: string or item-array `input` (`message`, `function_call`, `function_call_output`; bare `{role,content}` accepted), `instructions`, `tools` (flattened functions), `previous_response_id` continuation (in-memory, process-lifetime, FIFO ≤ 200), full canonical event brackets ending in `response.completed`.

Not supported (rejected where detectable, ignored elsewhere): image/audio inputs, `logprobs`, `n > 1`. `response_format json_object/json_schema` degrades to an instruction hint rather than wire-level enforcement.

## Local development

```sh
node --check lib/index.js     # syntax
node test/smoke.mjs           # stub-runtime protocol tests, no network
```
