/**
 * Standalone smoke test for @huyang2024/dsh-openai-api with a stubbed Cordis context
 * and a stubbed llm runtime. Exercises: models list, chat non-stream,
 * chat stream (incl. tool-call deltas + include_usage), responses non-stream,
 * responses stream (text + function_call brackets), previous_response_id
 * continuation, and auth failure paths.
 */
import { createServer } from "node:http";
import assert from "node:assert";

const mod = await import("../lib/index.js");

//#region stubs
function makeLlm(script) {
	return {
		listProviders() {
			return [{ id: "stub-provider", name: "Stub" }];
		},
		async listModels() {
			return [{ id: "stub-model", name: "Stub Model" }, { id: "other-model" }];
		},
		async *stream(options) {
			assert.strictEqual(options.provider, "stub-provider");
			for (const chunk of script(options)) yield chunk;
		},
	};
}

function makeCtx({ apiKeyConfig } = {}) {
	const routes = new Map();
	let llmScript = (options) => { void options; return []; };
	const ctx = {
		webServer: {
			register(route) {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			},
		},
		llm: makeLlm((options) => llmScript(options)),
		agentDefaultModel: {
			currentSelection() {
				return { provider: "stub-provider", model: "stub-model" };
			},
		},
		logger: { info() {}, warn(...args) { console.error("PLUGIN WARN:", ...args); } },
		effect(fn) {
			fn();
			return () => {};
		},
		get(name_) {
			if (name_ === "webServer") return this.webServer;
			if (name_ === "llm") return this.llm;
			if (name_ === "agentDefaultModel") return this.agentDefaultModel;
			return undefined;
		},
	};
	mod.apply(ctx, apiKeyConfig ? { apiKey: apiKeyConfig } : undefined);
	return {
		ctx,
		routes,
		setScript(fn) {
			llmScript = fn;
		},
	};
}

async function listen(handlerNodeStyle) {
	const server = createServer((req, res) => handlerNodeStyle(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return { server, url: `http://127.0.0.1:${port}` };
}

async function post(url, path, body, headers = {}) {
	const res = await fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, text, headers: res.headers };
}

function parseSse(text) {
	return text.split("\n\n").filter((block) => block.trim().length > 0).map((block) => {
		const lines = block.split("\n").filter((line) => line.startsWith("data: "));
		return lines.map((line) => {
			const payload = line.slice(6);
			if (payload === "[DONE]") return "[DONE]";
			try {
				return JSON.parse(payload);
			} catch {
				return { __raw: payload };
			}
		});
	}).flat();
}
//#endregion

let harness;
{
	const env = makeCtx();
	harness = env;
}
const handler = (req, res) => harness.routes.get(new URL(req.url, "http://x").pathname)(req, res);
const { server, url } = await listen(handler);

try {
	//#region GET /v1/models
	{
		harness.setScript(() => []);
		const res = await fetch(`${url}/v1/models`);
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.object, "list");
		assert.ok(body.data.some((model) => model.id === "stub-model"));
		console.log("models OK:", body.data.map((model) => model.id));
	}
	//#endregion

	//#region chat non-stream
	{
		harness.setScript(() => [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "Hello " },
			{ type: "text-delta", index: 0, text: "world." },
			{ type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } },
			{ type: "finish", reason: { kind: "stop" } },
		]);
		const { status, text } = await post(url, "/v1/chat/completions", { model: "stub-model", messages: [{ role: "user", content: "hi" }] });
		assert.strictEqual(status, 200);
		const body = JSON.parse(text);
		assert.strictEqual(body.object, "chat.completion");
		assert.strictEqual(body.choices[0].message.content, "Hello world.");
		assert.strictEqual(body.choices[0].finish_reason, "stop");
		assert.strictEqual(body.usage.prompt_tokens, 12);
		assert.strictEqual(body.usage.total_tokens, 16);
		console.log("chat non-stream OK:", body.choices[0].message.content);
	}
	//#endregion

	//#region chat stream with tools + include_usage
	{
		harness.setScript(() => [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "Let me check." },
			{ type: "tool-call-delta", index: 1, id: "call_abc", name: "get_weather", argumentsDelta: '{"ci' },
			{ type: "tool-call-delta", index: 1, id: "call_abc", argumentsDelta: 'ty":"Paris"}' },
			{ type: "usage", usage: { inputTokens: 20, outputTokens: 9 } },
			{ type: "finish", reason: { kind: "tool-calls" } },
		]);
		const { status, text } = await post(url, "/v1/chat/completions", {
			model: "stub-model",
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "weather?" }],
			tools: [{ type: "function", function: { name: "get_weather", description: "", parameters: { type: "object" } } }],
		});
		assert.strictEqual(status, 200);
		assert.match(text, /^data: /m);
		const events = parseSse(text);
		const finishFrame = events.find((event) => event.choices?.[0]?.finish_reason !== null && event.choices?.length === 1);
		assert.strictEqual(finishFrame.choices[0].finish_reason, "tool_calls");
		const usageFrame = events.find((event) => event.choices?.length === 0);
		assert.ok(usageFrame.usage.total_tokens > 0);
		assert.deepStrictEqual(events.at(-1), "[DONE]");
		assert.ok(text.endsWith("data: [DONE]\n\n"));
		const toolFrames = events.filter((event) => event.choices?.[0]?.delta?.tool_calls !== undefined);
		assert.strictEqual(toolFrames.length, 2);
		assert.strictEqual(toolFrames[0].choices[0].delta.tool_calls[0].id, "call_abc");
		console.log("chat stream OK; frames:", events.length);
	}
	//#endregion

	//#region chat round-trip with tool result replayed back into the bridge
	{
		let captured;
		harness.setScript((options) => {
			captured = options;
			return [
				{ type: "text-delta", index: 0, text: `Tool said: ${(JSON.parse(options.messages.at(-1).content[0].content[0].text)).city}` },
				{ type: "finish", reason: { kind: "stop" } },
			];
		});
		const { text } = await post(url, "/v1/chat/completions", {
			messages: [
				{ role: "user", content: "weather?" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
				{ role: "tool", tool_call_id: "call_abc", content: '{"city":"Paris"}' },
			],
		});
		const body = JSON.parse(text);
		assert.strictEqual(body.choices[0].message.content, "Tool said: Paris");
		// Correlation reaches the adapter as a frozen user-role message.
		assert.strictEqual(captured.messages[2].source.kind, "tool");
		assert.strictEqual(captured.messages[2].content[0].toolCallId, "call_abc");
		console.log("chat tool round-trip OK");
	}
	//#endregion

	//#region responses non-stream + previous_response_id continuation
	{
		harness.setScript(() => [
			{ type: "text-delta", index: 0, text: "Answer one." },
			{ type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
			{ type: "finish", reason: { kind: "stop" } },
		]);
		const first = await post(url, "/v1/responses", { model: "stub-provider/stub-model", input: "question one", instructions: "Be brief." });
		assert.strictEqual(first.status, 200);
		const firstBody = JSON.parse(first.text);
		assert.strictEqual(firstBody.object, "response");
		assert.strictEqual(firstBody.status, "completed");
		assert.strictEqual(firstBody.output_text ?? firstBody.output[0].content[0].text, "Answer one.");
		assert.strictEqual(firstBody.model, "stub-provider/stub-model");

		let sawMessages;
		harness.setScript((options) => {
			sawMessages = options;
			return [{ type: "text-delta", index: 0, text: "Answer two." }, { type: "finish", reason: { kind: "stop" } }];
		});
		const second = await post(url, "/v1/responses", { input: "question two", previous_response_id: firstBody.id });
		assert.strictEqual(second.status, 200);
		assert.ok(sawMessages.system.includes("Be brief."));
		assert.strictEqual(sawMessages.messages.filter((message) => message.role === "user").length, 2);
		console.log("responses non-stream + chain OK");
	}
	//#endregion

	//#region responses streaming with mixed content
	{
		harness.setScript(() => [
			{ type: "reasoning-delta", index: 1, text: "thinking..." },
			{ type: "text-delta", index: 0, text: "Hi " },
			{ type: "tool-call-delta", index: 2, id: "call_x", name: "lookup", argumentsDelta: "{\"a\":1}" },
			{ type: "usage", usage: { inputTokens: 7, outputTokens: 2 } },
			{ type: "finish", reason: { kind: "tool-calls" } },
		]);
		const { status, text } = await post(url, "/v1/responses", { input: "hi", stream: true });
		assert.strictEqual(status, 200);
		const blocks = text.split("\n\n").filter(Boolean).map((block) => {
			const eventLine = block.split("\n")[0];
			const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
			return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.slice(6)) };
		});
		const names = blocks.map((block) => block.event);
		assert.deepStrictEqual(names.slice(0, 2), ["response.created", "response.in_progress"]);
		assert.ok(names.includes("response.output_text.delta"));
		assert.ok(names.includes("response.function_call_arguments.delta"));
		assert.ok(names.includes("response.function_call_arguments.done"));
		assert.ok(names.includes("response.output_item.done"));
		const completed = blocks.find((block) => block.event === "response.completed");
		assert.strictEqual(completed.data.response.status, "completed");
		assert.strictEqual(completed.data.response.output[0].type, "message");
		assert.strictEqual(completed.data.response.output[0].content[0].text, "Hi ");
		assert.strictEqual(completed.data.response.output[1].type, "function_call");
		assert.strictEqual(completed.data.response.output[1].call_id, "call_x");
		assert.strictEqual(completed.data.response.usage.input_tokens, 7);
		// sequence numbers strictly increase
		const seqs = blocks.map((block) => block.data.sequence_number);
		for (const [index, seq] of seqs.entries()) if (index > 0) assert.ok(seq > seqs[index - 1]);
		console.log("responses stream OK; events:", names.length);
	}
	//#endregion

	//#region error paths
	{
		harness.setScript(() => [{ type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "bad key at provider", status: 401 } } }]);
		const bad = await post(url, "/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });
		assert.strictEqual(bad.status, 401);
		assert.strictEqual(JSON.parse(bad.text).error.code, "AUTH");
		const junk = await post(url, "/v1/chat/completions", { messages: [] });
		assert.strictEqual(junk.status, 400);
		const malformed = await post(url, "/v1/responses", {});
		assert.strictEqual(malformed.status, 400);
		console.log("error paths OK");
	}
	//#endregion

	//#region bearer auth
	{
		const guarded = makeCtx({ apiKeyConfig: "sekrit" });
		const authHandler = (req, res) => guarded.routes.get(new URL(req.url, "http://x").pathname)(req, res);
		const authed = await listen(authHandler);
		try {
			const denied = await fetch(`${authed.url}/v1/models`);
			assert.strictEqual(denied.status, 401);
			const wrong = await fetch(`${authed.url}/v1/models`, { headers: { authorization: "Bearer nope" } });
			assert.strictEqual(wrong.status, 401);
			const okk = await fetch(`${authed.url}/v1/models`, { headers: { authorization: "Bearer sekrit" } });
			assert.strictEqual(okk.status, 200);
			guarded.setScript(() => [{ type: "text-delta", index: 0, text: "ok" }, { type: "finish", reason: { kind: "stop" } }]);
			const chat = await post(authed.url, "/v1/chat/completions", { messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer sekrit" });
			assert.strictEqual(chat.status, 200);
			console.log("bearer auth OK");
		} finally {
			authed.server.close();
		}
	}
	//#endregion

	//#region config resolution regression (boot-time failure seen in profile)
	{
		const probeCtx = {
			webServer: { register(route) { void route; return () => {}; } },
			logger: { info() {}, warn() {} },
			effect(fn) { fn(); return () => {}; },
			get() { return undefined; },
		};
		// '' apiKey is the documented "auth disabled" value — must not throw.
		mod.apply(probeCtx, { apiKey: "", pathPrefix: "v9/" });
		let threw = false;
		try {
			mod.apply(probeCtx, { apiKey: "", maxBodyBytes: 5 });
		} catch {
			threw = true;
		}
		assert.ok(threw, "maxBodyBytes below floor must reject");
		console.log("config resolution OK");
	}
	//#endregion

	console.log("\nALL STUB TESTS PASSED");
} finally {
	server.close();
}
