/**
 * @huyang2024/dsh-openai-api —— 可直接运行的调用样例
 *
 * 前提：
 *   - 本机 DSH Desktop 已启动，web 服务监听 3080
 *   - openai-api 插件已在 profiles/web/cordis.patch.yml 中 insert 注册
 *   - 当前配置未设 apiKeys → 仅本机回环(127.0.0.1)可用，LAN 直连会被 401
 *
 * 运行：
 *   node example-usage.mjs
 *
 * 自定义（可选环境变量）：
 *   OPENAI_BASE=http://127.0.0.1:3080/v1   API_KEY=xxx   TIMEOUT_MS=60000   node example-usage.mjs
 */

const BASE = (process.env.OPENAI_BASE || "http://127.0.0.1:3080/v1").replace(/\/$/, "");
const API_KEY = process.env.API_KEY || "";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90000);
const PRESET = process.env.PRESET || "standard"; // 显式指定健康预设，避开损坏的默认预设(llm-wiki-fullstack/liangshen 都缺 prefix)

const H = (extra = {}) => {
  const h = { "content-type": "application/json", ...extra };
  if (API_KEY) h["authorization"] = `Bearer ${API_KEY}`;
  return h;
};

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getModels() {
  const res = await fetchWithTimeout(`${BASE}/models`, { headers: H() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /models -> ${res.status} ${text}`);
  return JSON.parse(text);
}

async function chatCompletions({ messages, stream = false, preset, sessionId }) {
  const headers = H();
  if (preset) headers["X-Agent-Preset"] = preset;
  if (sessionId) headers["X-Session-Id"] = encodeURIComponent(sessionId); // 中文角色名须 URL 编码，服务端按编码串隔离、显示时解码
  const res = await fetchWithTimeout(`${BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "default", messages, stream, stream_options: { include_usage: true } }),
  });
  if (!res.ok) throw new Error(`POST /chat/completions -> ${res.status} ${await res.text()}`);
  if (!stream) return await res.json();

  // SSE 流式：逐块解析 data: 行
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop();
    for (const block of blocks) {
      const m = block.match(/^data: (.*)$/m);
      if (!m) continue;
      const data = m[1].trim();
      if (data === "[DONE]") continue;
      out.push(JSON.parse(data));
    }
  }
  return out;
}

async function responses({ input, instructions, stream = false, preset, sessionId }) {
  const headers = H();
  if (preset) headers["X-Agent-Preset"] = preset;
  if (sessionId) headers["X-Agent-Preset"]; // no-op guard
  if (sessionId) headers["X-Session-Id"] = encodeURIComponent(sessionId); // 中文角色名须 URL 编码，服务端按编码串隔离、显示时解码
  const res = await fetchWithTimeout(`${BASE}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "default", input, instructions, stream }),
  });
  if (!res.ok) throw new Error(`POST /responses -> ${res.status} ${await res.text()}`);
  if (!stream) return await res.json();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop();
    for (const block of blocks) {
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const m = block.match(/^data: (.*)$/m);
      if (m) out.push({ event: ev, data: JSON.parse(m[1].trim()) });
    }
  }
  return out;
}

const log = (label, v) => console.log(`\n=== ${label} ===\n` + (typeof v === "string" ? v : JSON.stringify(v, null, 2)));

async function main() {
  console.log(`BASE=${BASE}  preset=${PRESET}  apiKey=${API_KEY ? "(set)" : "(none→loopback only)"}  timeout=${TIMEOUT_MS}ms`);

  // 0) 前置诊断：插件是否加载
  let models;
  try {
    models = await getModels();
    log("GET /v1/models", models);
  } catch (e) {
    console.error("\n[前置检查失败] 插件未响应，请确认：");
    console.error("  1) DSH Desktop 已启动且 web 监听 3080");
    console.error("  2) profiles/web/cordis.patch.yml 已 insert openai-api 并重启 profile");
    console.error("  错误：", e.message);
    process.exit(1);
  }

  // 1) Chat Completions 非流式
  const chat = await chatCompletions({ messages: [{ role: "user", content: "用一句话介绍你自己，你是谁？" }], preset: PRESET });
  log("POST /v1/chat/completions (non-stream)", {
    content: chat.choices?.[0]?.message?.content,
    finish_reason: chat.choices?.[0]?.finish_reason,
    usage: chat.usage,
  });

  // 2) Chat Completions 流式（按已提交 assistant 消息粒度）
  const stream = await chatCompletions({ messages: [{ role: "user", content: "数到三，每个数字一行。" }], stream: true, preset: PRESET });
  const streamedText = stream
    .filter((e) => e.choices?.[0]?.delta?.content)
    .map((e) => e.choices[0].delta.content)
    .join("");
  log("POST /v1/chat/completions (stream)", `deltas=${stream.length} text=${JSON.stringify(streamedText)}`);

  // 3) Responses API 非流式
  const resp = await responses({ input: "用一句话说明 Responses API 是什么。", instructions: "简洁。", preset: PRESET });
  log("POST /v1/responses (non-stream)", {
    status: resp.status,
    text: resp.output?.[0]?.content?.[0]?.text,
    usage: resp.usage,
  });

  // 4) 多角色隔离：两个 X-Session-Id 互不共享历史
  const sidA = "角色-小明";
  await chatCompletions({ messages: [{ role: "user", content: "记住：我的名字是小明。" }], sessionId: sidA, preset: PRESET });
  const rememberA = await chatCompletions({ messages: [{ role: "user", content: "我刚才说我叫什么？" }], sessionId: sidA, preset: PRESET });
  const sidB = "角色-小红";
  const forgetB = await chatCompletions({ messages: [{ role: "user", content: "我刚才说我叫什么？" }], sessionId: sidB, preset: PRESET });
  log("多角色隔离 (X-Session-Id)", {
    A_记住: rememberA.choices?.[0]?.message?.content,
    B_不记得: forgetB.choices?.[0]?.message?.content,
  });

  console.log("\n✅ 全部调用完成");
}

main().catch((e) => {
  console.error("\n❌ 运行出错：", e.message);
  process.exit(1);
});
