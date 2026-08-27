/**
 * @huyang2024/dsh-openai-api — OpenAI-compatible HTTP surface for dsh.
 *
 * Host plugin. Registers routes on the `webServer` service and serves:
 *
 *   POST <prefix>/chat/completions   OpenAI Chat Completions (stream + non-stream)
 *   POST <prefix>/responses          OpenAI Responses API subset (stream + non-stream,
 *                                    stateless plus a lightweight previous_response_id cache)
 *   GET  <prefix>/models             Model catalog aggregated over registered providers
 *
 * Generation is served by the harness `llm` runtime; the model defaults to the
 * deployment's `agentDefaultModel` selection unless the request names another
 * model (a `provider/model` pair, or an id found in some provider's catalog).
 *
 * Zero package dependencies: services are reached through ctx.get(), messages
 * are built as plain frozen objects matching the harness Message vocabulary,
 * and only node builtins are imported, so this plugin cannot drift against
 * compiled adapter internals or pull registry installs into the profile.
 *
 * Conventions observed from @deepseek-ai/dsh-client-connection: named exports
 * { name, inject, apply }, side effects owned via ctx.effect().
 */
import { randomUUID, timingSafeEqual } from "node:crypto";

//#region plugin metadata
/** Stable Cordis plugin name. */
const name = "openai-api";
/** Services required before any route exists. */
const inject = ["webServer"];
//#endregion

//#region configuration
const DEFAULT_CONFIG = Object.freeze({
	/** Route prefix for every served path. */
	pathPrefix: "/v1",
	/** Bearer key required from callers; empty string keeps loopback-only access. */
	apiKey: "",
	/** Maximum accepted JSON body size in bytes. */
	maxBodyBytes: 32 * 1024 * 1024,
	/** Extra browser origins allowed to call cross-origin (exact origin strings). */
	allowedOrigins: [],
});

function assertNonEmptyString(value, field) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`openai-api config.${field} must be a non-empty string`);
	}
	return value;
}

/** Validate raw composition config with schema-style defaults. */
function resolveConfig(raw) {
	const config = { ...DEFAULT_CONFIG };
	if (raw !== undefined && raw !== null) {
		if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("openai-api config must be an object");
		// apiKey explicitly allows '' (= auth disabled); other string keys must be non-empty.
		for (const key of ["apiKey"]) if (raw[key] !== undefined) config[key] = String(raw[key]);
		if (raw.pathPrefix !== undefined) config.pathPrefix = assertNonEmptyString(String(raw.pathPrefix), "pathPrefix");
		if (raw.maxBodyBytes !== undefined) {
			if (!Number.isSafeInteger(raw.maxBodyBytes) || raw.maxBodyBytes < 1024) throw new Error("openai-api config.maxBodyBytes must be an integer >= 1024");
			config.maxBodyBytes = raw.maxBodyBytes;
		}
		if (raw.allowedOrigins !== undefined) {
			if (!Array.isArray(raw.allowedOrigins)) throw new Error("openai-api config.allowedOrigins must be an array of origin strings");
			config.allowedOrigins = raw.allowedOrigins.map((value) => assertNonEmptyString(String(value), "allowedOrigins[]"));
		}
	}
	let prefix = config.pathPrefix;
	if (!prefix.startsWith("/")) prefix = `/${prefix}`;
	config.pathPrefix = prefix.replace(/\/+$/, "");
	return config;
}
//#endregion

//#region shared HTTP plumbing
class HttpError extends Error {
	constructor(status, type, code, message) {
		super(message);
		this.status = status;
		this.type = type;
		this.code = code;
	}
}

function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	if (address === "::1") return true;
	if (address.startsWith("::ffff:")) address = address.slice(7);
	return address === "127.0.0.1" || address.startsWith("127.");
}

function constantTimeEquals(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	if (a.length !== b.length) {
		// Still burn comparable time to avoid trivial length oracles.
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

function securityHeaders() {
	return {
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
	};
}

function corsDecision(req, config) {
	// Returns { allowed, echo }; echo is the Origin value worth reflecting.
	const origin = req.headers.origin;
	const host = req.headers.host ?? "";
	if (typeof origin !== "string" || origin.length === 0) return { allowed: true, echo: undefined };
	try {
		const originHost = new URL(origin).host;
		if (originHost === host) return { allowed: true, echo: origin };
	} catch {
		return { allowed: false, echo: undefined };
	}
	if (config.allowedOrigins.includes(origin)) return { allowed: true, echo: origin };
	return { allowed: false, echo: undefined };
}

function applyCorsHeaders(res, decision) {
	res.setHeader("vary", "Origin");
	if (decision.echo !== undefined) {
		res.setHeader("access-control-allow-origin", decision.echo);
		res.setHeader("access-control-expose-headers", "x-request-id");
	}
}

/**
 * Write an OpenAI-style error envelope. Falls back to a silent close once an
 * SSE stream already owns the response head.
 */
function sendOpenAiError(res, status, type, code, message, extra) {
	if (res.writableEnded || res.destroyed) return;
	if (res.headersSent) {
		res.end();
		return;
	}
	const body = { error: { message, type, code: code ?? null, param: extra?.param ?? null } };
	res.statusCode = status;
	res.setHeader("connection", "close");
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

/**
 * Trust fence + bearer auth. Runs before any body read.
 * @returns true when the request may proceed; otherwise the response was written.
 */
function authorize(req, res, config) {
	const decision = corsDecision(req, config);
	if (!decision.allowed) {
		sendOpenAiError(res, 403, "invalid_request_error", "origin_not_allowed", "openai-api: this origin may not call the OpenAI-compatible surface.");
		return false;
	}
	applyCorsHeaders(res, decision);
	if (req.method === "OPTIONS") {
		res.statusCode = 204;
		res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
		res.setHeader("access-control-allow-headers", "authorization, content-type");
		res.setHeader("access-control-max-age", "600");
		res.end();
		return false;
	}
	const configuredKey = config.apiKey;
	if (configuredKey.length > 0) {
		const headerValue = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] ?? "" : req.headers.authorization ?? "";
		const match = /^Bearer\s+(.+)$/.exec(headerValue);
		if (match === null || !constantTimeEquals(match[1], configuredKey)) {
			res.setHeader("www-authenticate", 'Bearer realm="openai-api"');
			sendOpenAiError(res, 401, "invalid_request_error", "invalid_api_key", "openai-api: missing or invalid API key (Authorization: Bearer <key>).");
			return false;
		}
		return true;
	}
	// No key configured: pin the surface to loopback callers so an accidental
	// LAN bind never exposes unauthenticated model access.
	if (!isLoopbackAddress(req.socket?.remoteAddress)) {
		sendOpenAiError(
			res, 403, "invalid_request_error", "unauthorized_remote",
			"openai-api: remote (non-loopback) callers require an apiKey in the openai-api row config.",
		);
		return false;
	}
	return true;
}

async function readJsonBody(req, res, maxBodyBytes) {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBodyBytes) {
		sendOpenAiError(res, 413, "invalid_request_error", "body_too_large", `openai-api: body exceeds maxBodyBytes (${maxBodyBytes}).`);
		return undefined;
	}
	const chunks = [];
	let total = 0;
	let aborted = false;
	req.on("aborted", () => {
		aborted = true;
	});
	try {
		for await (const chunk of req) {
			total += chunk.length;
			if (total > maxBodyBytes) {
				sendOpenAiError(res, 413, "invalid_request_error", "body_too_large", `openai-api: body exceeds maxBodyBytes (${maxBodyBytes}).`);
				return undefined;
			}
			chunks.push(chunk);
			if (aborted) return undefined;
		}
	} catch {
		// Client vanished mid-upload.
		return undefined;
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) {
		sendOpenAiError(res, 400, "invalid_request_error", "empty_body", "openai-api: expected a JSON body.");
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			sendOpenAiError(res, 400, "invalid_request_error", "invalid_json", "openai-api: body must be a JSON object.");
			return undefined;
		}
		return parsed;
	} catch {
		sendOpenAiError(res, 400, "invalid_request_error", "invalid_json", "openai-api: body is not valid JSON.");
		return undefined;
	}
}

function startSse(res) {
	res.writeHead(200, {
		...securityHeaders(),
		"content-type": "text/event-stream; charset=utf-8",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.flushHeaders?.();
	return function send(payload, event) {
		if (res.writableEnded || res.destroyed) return false;
		if (event !== undefined) res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
		return true;
	};
}

function responseEnded(res) {
	return res.writableEnded || res.destroyed;
}
//#endregion

//#region model resolution
const CATALOG_TTL_MS = 60_000;
/** providerId -> { at, ids:Set<modelId> }; advisory catalog cache for name routing. */
const catalogCache = new Map();

async function providerModelIds(llm, providerId) {
	const cached = catalogCache.get(providerId);
	const now = Date.now();
	if (cached !== undefined && now - cached.at < CATALOG_TTL_MS) return cached.ids;
	try {
		const ids = new Set();
		for (const model of await llm.listModels(providerId)) ids.add(model.id);
		catalogCache.set(providerId, { at: now, ids });
		return ids;
	} catch {
		// A transient listing failure keeps serving any previous valid entry
		// instead of pinning an empty catalog for the whole TTL.
		return cached?.ids ?? new Set();
	}
}

/**
 * Choose the (provider, model) route for one request.
 *
 * Priority: explicit "provider/model" pair > exact model id in a provider
 * catalog > the deployment default model carrying the requested id verbatim >
 * the default selection untouched.
 */
async function resolveTarget(ctx, requested) {
	const llm = ctx.get("llm");
	const defaultModel = ctx.get("agentDefaultModel");
	let selection = null;
	try {
		const current = defaultModel?.currentSelection?.();
		if (current && typeof current.provider === "string" && typeof current.model === "string") {
			selection = { provider: current.provider, model: current.model };
		}
	} catch {
		// Settings layer unavailable; fall back to llm-only routing below.
	}
	const providers = (llm.listProviders?.() ?? []).map((provider) => provider.id);
	const fallbackProvider = selection?.provider ?? providers[0];
	if (fallbackProvider === undefined) {
		throw new HttpError(503, "api_error", "no_provider", "openai-api: no LLM provider is currently registered; configure one under the llm-pi-ai or llm-deepseek settings section.");
	}
	const defaultTarget = { provider: fallbackProvider, model: selection?.model ?? "" };
	if (typeof requested !== "string" || requested.length === 0 || requested === "default" || requested === defaultTarget.model) {
		return { ...defaultTarget, effective: requested ?? defaultTarget.model };
	}
	if (requested.includes("/")) {
		const slash = requested.indexOf("/");
		const provider = requested.slice(0, slash);
		const model = requested.slice(slash + 1);
		if (provider.length > 0 && model.length > 0 && providers.includes(provider)) {
			return { provider, model, effective: requested };
		}
	}
	for (const provider of providers) {
		const ids = await providerModelIds(llm, provider);
		if (ids.has(requested)) return { provider, model: requested, effective: requested };
	}
	// Unknown id: keep the default provider and pass the name through. Catalogs
	// are advisory, and providers reject truly unknown models themselves.
	return { ...defaultTarget, model: defaultTarget.model.length > 0 ? defaultTarget.model : requested, effective: requested };
}
//#endregion

//#region OpenAI wire -> normalized turns -> harness conversation
const MAX_STOP_SEQUENCES = 4;

/**
 * The pure-JSON middle layer both endpoints normalize into before DSH mapping:
 * { role:'system'|'user'|'assistant'|'tool', text?, toolCalls?, toolCallId? }.
 */
function contentToText(content) {
	if (typeof content === "string") return content;
	if (content === null || content === undefined) return "";
	if (!Array.isArray(content)) {
		throw new HttpError(400, "invalid_request_error", "invalid_content", "openai-api: message content must be a string or an array of typed parts.");
	}
	const parts = [];
	for (const [index, part] of content.entries()) {
		if (part === null || typeof part !== "object") {
			throw new HttpError(400, "invalid_request_error", "invalid_content", `openai-api: content part ${index} must be an object.`);
		}
		switch (part.type) {
			case "text":
			case "input_text":
			case "output_text":
				parts.push(typeof part.text === "string" ? part.text : "");
				break;
			case "image_url":
			case "input_image":
			case "input_audio":
			case "file":
				throw new HttpError(400, "invalid_request_error", "unsupported_content", `openai-api: content part ${index} (${part.type}) is not supported by this bridge.`);
			default:
				throw new HttpError(400, "invalid_request_error", "invalid_content", `openai-api: unsupported content part type '${String(part.type)}' at index ${index}.`);
		}
	}
	return parts.filter((part) => part.length > 0).join("\n").trim();
}

function parseChatRequestMessages(body) {
	const raw = body.messages;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new HttpError(400, "invalid_request_error", "invalid_messages", "'messages' must be a non-empty array.");
	}
	const normalized = [];
	for (const [index, message] of raw.entries()) {
		if (message === null || typeof message !== "object" || Array.isArray(message)) {
			throw new HttpError(400, "invalid_request_error", "invalid_messages", `openai-api: messages[${index}] must be an object.`);
		}
		switch (message.role) {
			case "system":
			case "developer": {
				const text = contentToText(message.content).trim();
				if (text.length > 0) normalized.push({ role: "system", text });
				break;
			}
			case "user": {
				normalized.push({ role: "user", text: contentToText(message.content) });
				break;
			}
			case "assistant": {
				const entry = { role: "assistant", text: contentToText(message.content), toolCalls: [] };
				const calls = message.tool_calls;
				if (calls !== undefined) {
					if (!Array.isArray(calls)) throw new HttpError(400, "invalid_request_error", "invalid_tool_calls", `openai-api: messages[${index}].tool_calls must be an array.`);
					for (const call of calls) {
						if (call === null || typeof call !== "object" || call.type !== "function" || call.function === null || typeof call.function !== "object") {
							throw new HttpError(400, "invalid_request_error", "invalid_tool_calls", `openai-api: messages[${index}].tool_calls entries must be function calls.`);
						}
						const callId = typeof call.id === "string" ? call.id : "";
						if (callId.length === 0) throw new HttpError(400, "invalid_request_error", "invalid_tool_calls", `openai-api: messages[${index}].tool_calls[].id is required.`);
						entry.toolCalls.push({
							id: callId,
							name: String(call.function.name ?? ""),
							arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
						});
					}
				}
				if (entry.text.length > 0 || entry.toolCalls.length > 0) normalized.push(entry);
				break;
			}
			case "tool": {
				const callId = message.tool_call_id;
				if (typeof callId !== "string" || callId.length === 0) {
					throw new HttpError(400, "invalid_request_error", "invalid_tool_call_id", `openai-api: messages[${index}].tool_call_id is required on tool results.`);
				}
				normalized.push({ role: "tool", toolCallId: callId, text: contentToText(message.content), isError: message.is_error === true });
				break;
			}
			default:
				throw new HttpError(400, "invalid_request_error", "invalid_role", `openai-api: messages[${index}].role '${String(message.role)}' is not supported.`);
		}
	}
	return normalized;
}

/**
 * Responses-API input items -> the same normalized list. A bare string input
 * becomes a single user turn. Reasoning items are skipped; unknown item types
 * fail loudly rather than silently dropping context.
 */
function parseResponsesInput(input) {
	if (typeof input === "string") {
		return input.trim().length === 0 ? [] : [{ role: "user", text: input }];
	}
	if (input === null || input === undefined) {
		throw new HttpError(400, "invalid_request_error", "invalid_input", "'input' is required.");
	}
	if (!Array.isArray(input)) {
		throw new HttpError(400, "invalid_request_error", "invalid_input", "'input' must be a string or an array of items.");
	}
	const normalized = [];
	for (const [index, item] of input.entries()) {
		if (typeof item === "string") {
			normalized.push({ role: "user", text: item });
			continue;
		}
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] must be an object or string.`);
		}
		const kind = item.type;
		if (kind === undefined || kind === null) {
			// Plain { role, content } objects without a type tag are common.
			if (typeof item.role === "string" && item.content !== undefined) {
				appendRoleItem(normalized, item, index);
				continue;
			}
			throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] has no recognizable type.`);
		}
		switch (kind) {
			case "message":
				appendRoleItem(normalized, item, index);
				break;
			case "function_call": {
				const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : item.id;
				if (typeof callId !== "string" || callId.length === 0) {
					throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] function_call needs call_id.`);
				}
				normalized.push({
					role: "assistant",
					text: "",
					toolCalls: [{ id: callId, name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "{}" }],
				});
				break;
			}
			case "function_call_output": {
				const callId = item.call_id;
				if (typeof callId !== "string" || callId.length === 0) {
					throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] function_call_output needs call_id.`);
				}
				normalized.push({ role: "tool", toolCallId: callId, text: contentToText(item.output), isError: false });
				break;
			}
			case "reasoning":
				// Chain-of-thought replay items carry no prompt-relevant text here.
				break;
			default:
				throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] item type '${String(kind)}' is not supported.`);
		}
	}
	return normalized;

	function appendRoleItem(into, item, index) {
		switch (item.role) {
			case "system":
			case "developer": {
				const text = contentToText(item.content).trim();
				if (text.length > 0) into.push({ role: "system", text });
				return;
			}
			case "user":
				into.push({ role: "user", text: contentToText(item.content) });
				return;
			case "assistant": {
				const entry = { role: "assistant", text: contentToText(item.content), toolCalls: [] };
				if (entry.text.length > 0) into.push(entry);
				return;
			}
			default:
				throw new HttpError(400, "invalid_request_error", "invalid_input", `openai-api: input[${index}] role '${String(item.role)}' is not supported.`);
		}
	}
}

function jsonHintForResponseFormat(body) {
	const format = body.response_format;
	if (format === null || format === undefined) return undefined;
	if (typeof format !== "object" || typeof format.type !== "string") return undefined;
	if (format.type === "json_object") {
		return "Respond with a single valid JSON object and nothing else.";
	}
	if (format.type === "json_schema" && format.json_schema !== null && typeof format.json_schema === "object") {
		const schemaName = typeof format.json_schema.name === "string" ? format.json_schema.name : "response";
		return [
			`The ${schemaName} response MUST be a single valid JSON object conforming to the provided JSON Schema and contain nothing else.`,
			`JSON Schema: ${JSON.stringify(format.json_schema.schema ?? {})}`,
		].join("\n");
	}
	return undefined;
}

/** Request-level sampling controls -> GenerateOptions fields; throws HttpError. */
function samplingFrom(body) {
	const options = {};
	if (body.temperature !== undefined && body.temperature !== null) {
		if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
			throw new HttpError(400, "invalid_request_error", "invalid_temperature", "'temperature' must be a number between 0 and 2.");
		}
		options.temperature = body.temperature;
	}
	const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
	if (maxTokens !== undefined && maxTokens !== null) {
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
			throw new HttpError(400, "invalid_request_error", "invalid_max_tokens", "token limits must be positive integers.");
		}
		options.maxTokens = maxTokens;
	}
	const stop = body.stop;
	if (stop !== undefined && stop !== null) {
		const sequences = Array.isArray(stop) ? stop : [stop];
		if (sequences.length === 0 || sequences.length > MAX_STOP_SEQUENCES) {
			throw new HttpError(400, "invalid_request_error", "invalid_stop", `'stop' accepts at most ${MAX_STOP_SEQUENCES} sequences.`);
		}
		options.stop = sequences.map((sequence) => {
			if (typeof sequence !== "string" || sequence.length === 0) {
				throw new HttpError(400, "invalid_request_error", "invalid_stop", "'stop' sequences must be non-empty strings.");
			}
			return sequence;
		});
	}
	if (body.logprobs === true || (Array.isArray(body.top_logprobs) && body.top_logprobs.length > 0) || typeof body.top_logprobs === "number") {
		throw new HttpError(400, "invalid_request_error", "unsupported_parameter", "logprobs are not exposed by this bridge.");
	}
	return options;
}

function toolsFromBody(body) {
	const raw = body.tools;
	if (raw === undefined || raw === null) return { tools: undefined, forcedNone: body.tool_choice === "none" };
	if (!Array.isArray(raw)) throw new HttpError(400, "invalid_request_error", "invalid_tools", "'tools' must be an array.");
	const tools = [];
	for (const [index, entry] of raw.entries()) {
		if (entry === null || typeof entry !== "object") {
			throw new HttpError(400, "invalid_request_error", "invalid_tools", `openai-api: tools[${index}] must be an object.`);
		}
		// Chat Completions wrap functions in .function; the Responses API flattens them.
		const fn = entry.type === "function" ? entry.function ?? entry : entry;
		if (fn === null || typeof fn.name !== "string" || fn.name.length === 0) {
			throw new HttpError(400, "invalid_request_error", "invalid_tools", `openai-api: tools[${index}] must declare a function name.`);
		}
		tools.push({
			name: fn.name,
			description: typeof fn.description === "string" ? fn.description : "",
			parameters: fn.parameters !== null && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
		});
	}
	return { tools: tools.length > 0 ? tools : undefined, forcedNone: body.tool_choice === "none" };
}

/**
 * Normalized turns -> immutable harness Message vocabulary. Ids are fresh per
 * request; correlation inside ONE call relies on the call ids carried by
 * content blocks, which mirror exactly what the client sent back.
 */
function normalizedToDshMessages(normalized, provenance) {
	const systemParts = [];
	const messages = [];
	for (const entry of normalized) {
		if (entry.role === "system") {
			systemParts.push(entry.text);
			continue;
		}
		if (entry.role === "user") {
			messages.push(Object.freeze({
				id: randomUUID(),
				role: "user",
				content: Object.freeze([Object.freeze({ type: "text", text: entry.text })]),
				source: Object.freeze({ kind: "user" }),
			}));
			continue;
		}
		if (entry.role === "assistant") {
			const content = [];
			if (entry.text.length > 0) content.push({ type: "text", text: entry.text });
			for (const call of entry.toolCalls ?? []) {
				content.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
			}
			messages.push(Object.freeze({
				id: randomUUID(),
				role: "assistant",
				content: Object.freeze(content.map(Object.freeze)),
				source: Object.freeze({ kind: "model", provider: provenance.provider, model: provenance.model }),
			}));
			continue;
		}
		// Tool-result turn.
		messages.push(Object.freeze({
			id: randomUUID(),
			role: "user",
			content: Object.freeze([
				Object.freeze({
					type: "tool-result",
					toolCallId: entry.toolCallId,
					content: Object.freeze([Object.freeze({ type: "text", text: entry.text })]),
					isError: entry.isError === true,
				}),
			]),
			source: Object.freeze({ kind: "tool", callId: entry.toolCallId }),
		}));
	}
	const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
	return { system, messages };
}
//#endregion

//#region harness stream -> shared event pump
function createAccumulator() {
	return { text: "", reasoning: "", calls: [], usage: null, finish: null, failed: null };
}

function feedChunk(acc, chunk) {
	switch (chunk.type) {
		case "text-delta":
			acc.text += chunk.text;
			break;
		case "reasoning-delta":
			acc.reasoning += chunk.text;
			break;
		case "tool-call-delta": {
			let call = acc.calls.find((entry) => entry.id === chunk.id);
			if (call === undefined) {
				call = { id: chunk.id, name: "", arguments: "" };
				acc.calls.push(call);
			}
			if (typeof chunk.name === "string" && chunk.name.length > 0) call.name = chunk.name;
			call.arguments += chunk.argumentsDelta;
			break;
		}
		case "usage":
			acc.usage = {
				inputTokens: Number(chunk.usage.inputTokens ?? 0),
				outputTokens: Number(chunk.usage.outputTokens ?? 0),
				cacheReadTokens: chunk.usage.cacheReadTokens,
				cacheWriteTokens: chunk.usage.cacheWriteTokens,
				reasoningTokens: chunk.usage.reasoningTokens,
			};
			break;
		case "finish":
			acc.finish = chunk.reason;
			break;
		default:
			break;
	}
}

function openAiUsage(usage) {
	if (usage === null) return undefined;
	const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	const prompt = usage.inputTokens + cached;
	const completion = usage.outputTokens;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_tokens_details: { cached_tokens: cached },
		completion_tokens_details: usage.reasoningTokens ? { reasoning_tokens: usage.reasoningTokens } : undefined,
	};
}

function responsesUsage(usage) {
	if (usage === null) return undefined;
	const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	return {
		input_tokens: usage.inputTokens + cached,
		output_tokens: usage.outputTokens,
		total_tokens: usage.inputTokens + cached + usage.outputTokens,
		input_tokens_details: { cached_tokens: cached },
		output_tokens_details: usage.reasoningTokens ? { reasoning_tokens: usage.reasoningTokens } : undefined,
	};
}

function failureStatus(failure) {
	const status = typeof failure?.status === "number" ? Math.trunc(failure.status) : 500;
	return status >= 400 && status <= 599 ? status : 500;
}

function errorTypeFor(status) {
	if (status === 401 || status === 403) return "authentication_error";
	if (status === 429) return "rate_limit_error";
	if (status >= 400 && status < 500) return "invalid_request_error";
	return "api_error";
}

/**
 * Drive one harness stream to completion.
 *
 * Adapter/provider failures arrive as terminal chunks (kept in the
 * accumulator); thrown middleware errors convert into `failed`. A client
 * disconnect aborts upstream once, then the remaining drain continues
 * silently. Every delivery after terminal chunks stops iterating.
 */
async function pumpStream(llm, target, options, accumulator, res, onChunk) {
	const controller = new AbortController();
	let clientGone = false;
	const markClientGone = () => {
		clientGone = true;
		controller.abort();
	};
	res.on("close", markClientGone);
	try {
		const stream = llm.stream({
			provider: target.provider,
			model: target.model,
			signal: controller.signal,
			...options,
		});
		for await (const chunk of stream) {
			feedChunk(accumulator, chunk);
			if (chunk.type === "finish") {
				// Handlers decide how terminal outcomes surface (SSE error
				// contracts are written while the socket can still take them).
				onChunk?.(chunk);
				break;
			}
			if (!clientGone && !responseEnded(res)) onChunk?.(chunk);
		}
	} catch (error) {
		if (!clientGone) {
			accumulator.failed = {
				message: error instanceof Error ? error.message : String(error),
				code: typeof error?.code === "string" ? error.code : "BRIDGE_ERROR",
			};
		}
	} finally {
		res.removeListener("close", markClientGone);
	}
}

/** Shared terminal-failure reporter for non-stream paths; true when handled. */
function reportTerminalFailure(acc, res) {
	if (responseEnded(res)) return true;
	if (acc.failed !== null) {
		const status = failureStatus(acc.failed);
		sendOpenAiError(res, status, errorTypeFor(status), acc.failed.code ?? null, acc.failed.message);
		return true;
	}
	if (acc.finish !== null && (acc.finish.kind === "error" || acc.finish.kind === "aborted")) {
		const failure = acc.finish.failure ?? {};
		const status = failureStatus(failure);
		sendOpenAiError(res, status, errorTypeFor(status), failure.code ?? null, failure.message ?? "model call failed");
		return true;
	}
	if (acc.finish === null) {
		sendOpenAiError(res, 502, "api_error", "empty_stream", "openai-api: the model stream ended without a terminal event.");
		return true;
	}
	return false;
}
//#endregion

//#region chat completions endpoint
function finishKindToOpenAi(kind) {
	switch (kind) {
		case "tool-calls": return "tool_calls";
		case "max-tokens": return "length";
		case "length": return "length";
		case "stop-sequence": return "stop";
		default: return "stop";
	}
}

async function handleChatCompletions(context, req, res) {
	const { config } = context;
	const llm = context.env.ctx.get("llm");
	if (!authorize(req, res, config)) return;
	if (req.method !== "POST") {
		sendOpenAiError(res, 405, "invalid_request_error", "method_not_allowed", "openai-api: use POST /v1/chat/completions.");
		return;
	}
	const body = await readJsonBody(req, res, config.maxBodyBytes);
	if (body === undefined) return;
	if (llm === undefined) {
		sendOpenAiError(res, 503, "api_error", "llm_unavailable", "openai-api: the harness llm service is not mounted yet.");
		return;
	}
	if (body.n !== undefined && body.n !== 1) {
		sendOpenAiError(res, 400, "invalid_request_error", "unsupported_parameter", "Only n=1 is supported.");
		return;
	}

	// Everything that can reject with HttpError completes BEFORE any stream head.
	const target = await resolveTarget(context.env.ctx, body.model);
	const normalized = parseChatRequestMessages(body);
	const hint = jsonHintForResponseFormat(body);
	if (hint !== undefined) normalized.unshift({ role: "system", text: `[SYSTEM BRIDGE NOTE] ${hint}` });
	const provenance = { provider: target.provider, model: target.model };
	const { system, messages } = normalizedToDshMessages(normalized, provenance);
	const { tools, forcedNone } = toolsFromBody(body);
	const sampling = samplingFrom(body);
	const requestOptions = {
		messages,
		...(system ? { system } : {}),
		...(!forcedNone && tools ? { tools } : {}),
		...sampling,
	};

	const wantsStream = body.stream === true;
	const includeUsage = body.stream_options?.include_usage === true;
	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);

	if (!wantsStream) {
		const acc = createAccumulator();
		await pumpStream(llm, target, requestOptions, acc, res, undefined);
		if (reportTerminalFailure(acc, res)) return;
		const message = { role: "assistant", content: acc.text.length > 0 ? acc.text : null };
		if (acc.reasoning.length > 0) message.reasoning_content = acc.reasoning;
		if (acc.calls.length > 0) {
			message.tool_calls = acc.calls.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			}));
		}
		const payload = {
			id,
			object: "chat.completion",
			created,
			model: target.effective,
			system_fingerprint: `dsh_${target.provider}`,
			choices: [{
				index: 0,
				message,
				logprobs: null,
				finish_reason: acc.finish === null ? "stop" : finishKindToOpenAi(acc.finish.kind),
			}],
		};
		const usage = openAiUsage(acc.usage);
		if (usage !== undefined) payload.usage = usage;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(payload));
		return;
	}

	// Streaming.
	const send = startSse(res);
	const acc = createAccumulator();
	const toolSendIndex = new Map();
	let started = false;
	let finishKind = null;
	let seenTerminalFailure = null;

	const baseFrame = (delta, finish_reason, usage) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model: target.effective,
		system_fingerprint: `dsh_${target.provider}`,
		choices: [{ index: 0, delta, finish_reason }],
		...(usage !== undefined ? { usage } : {}),
	});

	await pumpStream(llm, target, requestOptions, acc, res, (chunk) => {
		switch (chunk.type) {
			case "block-start":
				if (!started && chunk.blockType === "text") emitRoleFrame();
				break;
			case "text-delta":
				emitRoleFrame();
				send(baseFrame({ content: chunk.text }, null));
				break;
			case "reasoning-delta":
				send(baseFrame({ reasoning_content: chunk.text }, null));
				break;
			case "tool-call-delta": {
				let index = toolSendIndex.get(chunk.id);
				if (index === undefined) {
					index = toolSendIndex.size;
					toolSendIndex.set(chunk.id, index);
				}
				send(baseFrame({
					tool_calls: [{
						index,
						...(chunk.name === undefined ? {} : { id: chunk.id, type: "function" }),
						function: {
							...(chunk.name === undefined ? {} : { name: chunk.name }),
							arguments: chunk.argumentsDelta,
						},
					}],
				}, null));
				break;
			}
			case "finish": {
				if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
					seenTerminalFailure = chunk.reason.failure ?? {};
					return;
				}
				finishKind = finishKindToOpenAi(chunk.reason.kind);
				break;
			}
			default:
				break;
		}
	});

	if (responseEnded(res)) return;
	if (seenTerminalFailure !== null) {
		// Mid-stream provider failures use the data-channel error contract.
		const status = failureStatus(seenTerminalFailure);
		send({ error: { message: seenTerminalFailure.message ?? "model call failed", type: errorTypeFor(status), code: seenTerminalFailure.code ?? null, param: null } });
		res.write("data: [DONE]\n\n");
		res.end();
		return;
	}
	if (!started) send(baseFrame({ role: "assistant", content: "" }, null));
	if (finishKind === null) finishKind = "stop";
	const usage = openAiUsage(acc.usage);
	if (includeUsage && usage !== undefined) {
		// Canonical include_usage shape: the finish frame first, then one
		// choices-less usage frame, then [DONE].
		send(baseFrame({}, finishKind));
		send({
			id,
			object: "chat.completion.chunk",
			created,
			model: target.effective,
			system_fingerprint: `dsh_${target.provider}`,
			choices: [],
			usage,
		});
	} else {
		send(baseFrame({}, finishKind, usage));
	}
	res.write("data: [DONE]\n\n");
	res.end();

	function emitRoleFrame() {
		if (started) return;
		started = true;
		send(baseFrame({ role: "assistant", content: "" }, null));
	}
}
//#endregion

//#region previous_response_id store
const RESPONSE_CACHE_LIMIT = 200;
/** responseId -> { turns, instructions }; FIFO eviction. */
const responseCache = new Map();

function cacheResponse(responseId, turns, instructions) {
	responseCache.set(responseId, { turns, instructions });
	while (responseCache.size > RESPONSE_CACHE_LIMIT) {
		responseCache.delete(responseCache.keys().next().value);
	}
}
//#endregion

//#region responses endpoint
function baseResponse(responseId, createdAt, model, extras) {
	return {
		id: responseId,
		object: "response",
		created_at: createdAt,
		status: extras.status ?? "completed",
		error: extras.error ?? null,
		incomplete_details: null,
		instructions: extras.instructions ?? null,
		metadata: {},
		model,
		output: extras.output ?? [],
		parallel_tool_calls: true,
		previous_response_id: extras.previousResponseId ?? null,
		reasoning: { effort: null, summary: null },
		store: false,
		temperature: extras.temperature ?? null,
		text: { format: { type: "text" } },
		tool_choice: "auto",
		tools: extras.tools ?? [],
		top_p: null,
		truncation: "disabled",
		usage: extras.usage ?? {
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
		user: null,
	};
}

async function handleResponses(context, req, res) {
	const { config } = context;
	const llm = context.env.ctx.get("llm");
	if (!authorize(req, res, config)) return;
	if (req.method !== "POST") {
		sendOpenAiError(res, 405, "invalid_request_error", "method_not_allowed", "openai-api: use POST /v1/responses.");
		return;
	}
	const body = await readJsonBody(req, res, config.maxBodyBytes);
	if (body === undefined) return;
	if (llm === undefined) {
		sendOpenAiError(res, 503, "api_error", "llm_unavailable", "openai-api: the harness llm service is not mounted yet.");
		return;
	}

	// Validation happens before any stream head.
	const target = await resolveTarget(context.env.ctx, body.model);
	const priorEntry = body.previous_response_id != null ? responseCache.get(body.previous_response_id) : undefined;
	if (body.previous_response_id != null && priorEntry === undefined) {
		sendOpenAiError(res, 400, "invalid_request_error", "unknown_previous_response", `openai-api: previous_response_id '${String(body.previous_response_id)}' is unknown (in-memory, process-lifetime cache).`);
		return;
	}
	const currentTurns = parseResponsesInput(body.input);
	const instructionText = typeof body.instructions === "string" && body.instructions.trim().length > 0
		? body.instructions.trim()
		: priorEntry?.instructions;
	const hint = jsonHintForResponseFormat(body);
	const chain = [...(priorEntry?.turns ?? []), ...currentTurns];
	const normalizedWithInstructions = [
		...(instructionText !== undefined ? [{ role: "system", text: instructionText }] : []),
		...(hint !== undefined ? [{ role: "system", text: `[SYSTEM BRIDGE NOTE] ${hint}` }] : []),
		...chain,
	];
	const provenance = { provider: target.provider, model: target.model };
	const { system, messages } = normalizedToDshMessages(normalizedWithInstructions, provenance);
	const { tools, forcedNone } = toolsFromBody(body);
	const sampling = samplingFrom(body);
	const requestOptions = {
		messages,
		...(system ? { system } : {}),
		...(!forcedNone && tools ? { tools } : {}),
		...sampling,
	};

	const createdAt = Math.floor(Date.now() / 1000);
	const responseId = `resp_${randomUUID()}`;
	const extrasBase = {
		instructions: instructionText,
		previousResponseId: body.previous_response_id ?? null,
		temperature: body.temperature ?? null,
		tools: tools ?? [],
	};

	/**
	 * One streaming registry is the single ordering authority: streamed bracket
	 * indices and the final output array derive from the same item list.
	 */
	const wantsStream = body.stream === true;

	if (!wantsStream) {
		const acc = createAccumulator();
		await pumpStream(llm, target, requestOptions, acc, res, undefined);
		if (reportTerminalFailure(acc, res)) return;
		const output = [];
		if (acc.text.length > 0) {
			output.push({
				id: `msg_${randomUUID()}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: acc.text, annotations: [] }],
			});
		}
		for (const call of acc.calls) {
			output.push({
				id: `fc_${randomUUID()}`,
				type: "function_call",
				status: "completed",
				call_id: call.id,
				name: call.name,
				arguments: call.arguments,
			});
		}
		cacheResponse(responseId, chain, instructionText);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(baseResponse(responseId, createdAt, target.effective, {
			...extrasBase,
			output,
			usage: responsesUsage(acc.usage),
		})));
		return;
	}

	// Streaming: canonical Responses SSE brackets, then response.completed.
	const send = startSse(res);
	const acc = createAccumulator();
	let sequence = 0;
	const nextSequence = () => ++sequence;
	const emit = (event, payload) => send({ type: event, sequence_number: nextSequence(), ...payload }, event);

	const skeletonExtras = { ...extrasBase, status: "in_progress" };
	emit("response.created", { response: baseResponse(responseId, createdAt, target.effective, skeletonExtras) });
	emit("response.in_progress", { response: baseResponse(responseId, createdAt, target.effective, skeletonExtras) });

	// Streaming registry — the single ordering authority. Streamed bracket
	// indices and the final output array derive from the same item list; items
	// materialize lazily on their first content and announce themselves.
	let assembly = null;
	function getAssembly() {
		if (assembly !== null) return assembly;
		const items = [];
		const indexOfItem = (item) => items.indexOf(item);
		function ensureMessage() {
			let item = items.find((entry) => entry.kind === "message");
			if (item === undefined) {
				item = { kind: "message", id: `msg_${randomUUID()}`, text: "" };
				items.push(item);
				emit("response.output_item.added", {
					output_index: indexOfItem(item),
					item: {
						id: item.id,
						type: "message",
						status: "in_progress",
						role: "assistant",
						content: [{ type: "output_text", text: "", annotations: [] }],
					},
				});
				emit("response.content_part.added", { item_id: item.id, output_index: indexOfItem(item), content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
			}
			return item;
		}
		function ensureTool(callId, name) {
			let item = items.find((entry) => entry.kind === "function_call" && entry.callId === callId);
			if (item !== undefined) {
				if (name.length > 0 && item.name.length === 0) item.name = name;
				return item;
			}
			item = { kind: "function_call", id: `fc_${randomUUID()}`, callId, name };
			items.push(item);
			emit("response.output_item.added", {
				output_index: indexOfItem(item),
				item: {
					id: item.id,
					type: "function_call",
					status: "in_progress",
					call_id: item.callId,
					name: item.name,
					arguments: "",
				},
			});
			return item;
		}
		assembly = { items, ensureMessage, ensureTool };
		return assembly;
	}

	let sawTerminalFailure = null;

	await pumpStream(llm, target, requestOptions, acc, res, (chunk) => {
		switch (chunk.type) {
			case "text-delta": {
				const asm = getAssembly();
				const item = asm.ensureMessage();
				item.text += chunk.text;
				emit("response.output_text.delta", { item_id: item.id, output_index: asm.items.indexOf(item), content_index: 0, delta: chunk.text });
				break;
			}
			case "reasoning-delta":
				// Reasoning streams stay internal in v1.
				break;
			case "tool-call-delta": {
				const asm = getAssembly();
				const item = asm.ensureTool(chunk.id, chunk.name ?? "");
				if (chunk.argumentsDelta.length > 0) {
					emit("response.function_call_arguments.delta", { item_id: item.id, output_index: asm.items.indexOf(item), delta: chunk.argumentsDelta });
				}
				break;
			}
			case "finish": {
				if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
					sawTerminalFailure = chunk.reason.failure ?? {};
				}
				break;
			}
			default:
				break;
		}
	});

	if (responseEnded(res)) return;

	if (sawTerminalFailure !== null) {
		const failed = baseResponse(responseId, createdAt, target.effective, {
			...extrasBase,
			status: "failed",
			error: {
				code: sawTerminalFailure.code ?? null,
				message: sawTerminalFailure.message ?? "model call failed",
			},
			usage: responsesUsage(acc.usage),
		});
		emit("response.failed", { response: failed });
		res.end();
		return;
	}

	// Close open brackets: every streamed item becomes a done event, and the
	// final output array mirrors the same order.
	const finishedItems = assembly?.items ?? [];
	const output = [];
	for (const [outputIndex, item] of finishedItems.entries()) {
		if (item.kind === "message") {
			emit("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: item.text });
			emit("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } });
			const completed = {
				id: item.id,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: item.text, annotations: [] }],
			};
			emit("response.output_item.done", { output_index: outputIndex, item: completed });
			output.push(completed);
		} else {
			// The accumulator is authoritative for name/arguments.
			const call = acc.calls.find((entry) => entry.id === item.callId) ?? { name: item.name, arguments: "" };
			emit("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: call.arguments });
			const completed = {
				id: item.id,
				type: "function_call",
				status: "completed",
				call_id: item.callId,
				name: call.name,
				arguments: call.arguments,
			};
			emit("response.output_item.done", { output_index: outputIndex, item: completed });
			output.push(completed);
		}
	}

	cacheResponse(responseId, chain, instructionText);
	emit("response.completed", { response: baseResponse(responseId, createdAt, target.effective, {
		...extrasBase,
		output,
		usage: responsesUsage(acc.usage),
	}) });
	res.end();
}
//#endregion

//#region models endpoint
async function handleModels(context, req, res) {
	const { config } = context;
	const llm = context.env.ctx.get("llm");
	if (!authorize(req, res, config)) return;
	if (req.method !== "GET") {
		sendOpenAiError(res, 405, "invalid_request_error", "method_not_allowed", "openai-api: use GET /v1/models.");
		return;
	}
	if (llm === undefined) {
		sendOpenAiError(res, 503, "api_error", "llm_unavailable", "openai-api: the harness llm service is not mounted yet.");
		return;
	}
	const data = [];
	const seen = new Set();
	for (const provider of llm.listProviders?.() ?? []) {
		const ids = await providerModelIds(llm, provider.id);
		for (const modelId of ids) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			data.push({ id: modelId, object: "model", created: 0, owned_by: provider.id });
		}
	}
	if (seen.size === 0) {
		try {
			const selection = context.env.ctx.get("agentDefaultModel")?.currentSelection?.();
			if (selection && typeof selection.model === "string") {
				data.push({ id: selection.model, object: "model", created: 0, owned_by: selection.provider });
			}
		} catch {
			// Metadata service absent; an empty list is honest.
		}
	}
	res.writeHead(200, { ...securityHeaders(), "content-type": "application/json" });
	res.end(JSON.stringify({ object: "list", data }));
}
//#endregion

//#region plugin
/**
 * @param ctx - Host plugin context (Cordis).
 * @param rawConfig - resolved composition row config.
 */
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const context = { config, env: { ctx } };
	/** Route boundary: every rejection becomes a well-formed error envelope. */
	const guarded = (handler) => async (req, res) => {
		try {
			await handler(req, res);
		} catch (error) {
			if (error instanceof HttpError) {
				sendOpenAiError(res, error.status, error.type, error.code, error.message);
				return;
			}
			ctx.logger?.warn?.("openai-api: unhandled request failure:", error);
			sendOpenAiError(res, 500, "api_error", "bridge_error", error instanceof Error ? error.message : String(error));
		}
	};
	const routes = [
		{
			kind: "exact",
			path: `${config.pathPrefix}/chat/completions`,
			handler: guarded((req, res) => handleChatCompletions(context, req, res)),
		},
		{
			kind: "exact",
			path: `${config.pathPrefix}/responses`,
			handler: guarded((req, res) => handleResponses(context, req, res)),
		},
		{
			kind: "exact",
			path: `${config.pathPrefix}/models`,
			handler: guarded((req, res) => handleModels(context, req, res)),
		},
	];
	for (const route of routes) {
		ctx.effect(() => ctx.webServer.register(route), `openai-api: ${route.path}`);
	}
	ctx.logger?.info?.(
		"openai-api: serving %s/chat/completions, %s/responses, %s/models (auth: %s)",
		config.pathPrefix, config.pathPrefix, config.pathPrefix,
		config.apiKey.length > 0 ? "bearer key" : "loopback-only",
	);
}

export { apply, inject, name };
//#endregion
