# @huyang2024/dsh-openai-api

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供标准 OpenAI 兼容 HTTP 接口的插件，由 **真实 DSH Agent 会话** 提供服务。

安装到 dsh 配置（profile）后，harness 的 Web 服务会额外提供：

| 接口 | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | Chat Completions API（流式 + 非流式） |
| `POST /v1/responses` | Responses API 子集（流式 + 非流式） |
| `GET /v1/models` | 广告的模型 id |

## “Agent 承载”含义

每个请求由 **一个存活的 DSH Agent 会话** 服务（harness 的 `agents` 注册表 + agent 循环），因此每次调用都获得 agent 的完整世界：其配置的工具、bash/文件访问、技能、提示词分段和预设人格。这是 **agent 网关**，不是轻量 LLM 代理：

- **工具调用由 agent 自主决定**。客户端的 `tools` / `tool_choice` / function-call 消息会被拒绝——由 agent 决定调用哪些工具以及为什么。
- 流式 delta **按每一条已提交的 assistant 消息** 到达，而非按 token。思考、工具调用和 token 级块流都不上线路；只有已提交的 assistant 文本到达客户端。
- 每个 `(key, preset)` 组合的**首个请求**会通过把客户端完整消息数组渲染成带标签的转写提示来**播种**会话；后续请求只接收最新用户轮次（会话已持有历史）。

## 会话身份

`(API key 租户, X-Agent-Preset, X-Session-Id)` 三元组：

- 被接受的 **apiKey 为调用者命名空间** —— 每个 key 一个租户，因此不同 key 即使同 preset 也绝不共享会话，客户端重连会恢复自己的会话。
- **`X-Agent-Preset` 头** 指定会话加入的预设（缺省 → profile 默认预设）。仅在会话创建时解析。
- **`X-Session-Id` 头** 把会话身份扩展为第三维：每个 `X-Session-Id` 一个独立 dsh 会话，互不复用历史。中文角色名需由客户端 `encodeURIComponent` 编码（服务端仅用于会话标题显示时还原）。若未设置，则回退到 `(key, preset)` 单一会话。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:huyang2024/dsh-openai-api

# 或本地目录安装
dsh plugin --profile web add file:/absolute/path/to/dsh-openai-api
```

再在 profile 用户补丁层 `$DSH_HOME/profiles/web/cordis.patch.yml` 中以 `insert:` 方式加入新行（补丁层的裸 `{id, name}` 条目只用于改写下层已有行，不会生效）：

```yaml
- insert:
    - id: openai-api
      name: '@huyang2024/dsh-openai-api'
      inject: [webServer]
      config:
        pathPrefix: '/v1'     # 可选，默认值如此
        apiKeys: []           # 可选，见下表
        model: default        # 可选；/v1/models 广告的模型 id
        provider: ''          # 可选；创建会话使用的 provider 路由
        cwd: ''               # 可选；会话绝对工作目录
```

重启 profile 使新行生效。

## 配置

所有键可选；创建的会话回退到宿主默认值。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `model` | `default` | `/v1/models` 广告的模型 id。请求 `model`（缺省或等于此值）时使用宿主默认选择；其它 id 作为模型传入会话。 |
| `provider` | 宿主默认 | 创建会话使用的 provider 路由。 |
| `apiKeys` | 未设 | 每客户端密钥。每个不同 key 是一个独立租户；会话身份为 `(key, preset, X-Session-Id)` 三元组，每个 `X-Session-Id` 一个独立 dsh 会话。设置后，请求必须携带一个（`Authorization: Bearer <key>`），否则 401。未设置时，表面是单个无密钥租户，**仅限本机回环** 调用。 |
| `cwd` | `dsh web` 进程 cwd | 创建会话的绝对工作目录。必须以 `/` 开头。 |
| `stateless` | `false` | 无状态模式：每次请求自包含，不复用/持久化服务端的 dsh 会话（每次请求创建新会话、完成后即销毁）。开启后行为与标准无状态 LLM 端点一致——客户端需在每轮请求中发送完整 `messages` 历史。 |

## 使用 API

```js
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: 'http://127.0.0.1:3080/v1', apiKey: 'local-key' })

// 可选：指定会话加入的 agent 预设（缺省 → 默认预设）。
const preset = { 'X-Agent-Preset': 'custom-agent-preset' }

const reply = await client.chat.completions.create(
  { model: 'default', messages: [{ role: 'user', content: 'What are you?' }] },
  { headers: preset },
)
```

`/v1/responses` 遵循同一会话模型；`previous_response_id` 被接受但忽略（粘性会话本身就是存储）。

## 与 OpenAI 的差异（已知限制）

本端点由真实 DSH agent 会话承载，并非无状态 LLM 代理。以下是与标准 OpenAI API 的明确差异——**不支持的参数会被显式拒绝（400），而不是静默忽略**，以免上游客户端得到错误/非确定性的输出。

| 维度 | 行为 |
| --- | --- |
| **有状态会话** | 默认：首个请求把完整 `messages` 渲染成 transcript 一次性 seed；后续同 `X-Session-Id` 请求只取最后一条非空 user 轮，数组其余部分被忽略（历史在服务端会话里）。这与「每请求自包含」的标准 LLM 语义不同。设置 `stateless: true` 可关闭此行为。 |
| **采样 / 生成控制参数** | `temperature`、`top_p`、`top_k`、`presence_penalty`、`frequency_penalty`、`stop`、`seed`、`logit_bias`、`logprobs`、`reasoning_effort` 均 **不被 harness 接受**，请求携带即返回 `400`（说明 not supported）。请勿依赖这些参数获得确定性或特定采样。 |
| **工具调用** | `tools` / `tool_choice` / `functions` / `function_call` 及 `tool` role 消息一律 `400` 拒绝——工具调用由 agent 自行决定。任何发送工具的 SDK / 框架（如 LangChain、Assistants）会失败。 |
| **结构化输出** | `response_format`（`json_object` 等）与 Responses 的 `text.format` 非 `text` 类型一律 `400` 拒绝；本端点只输出纯文本。 |
| **多模态 / 视觉** | `content` 数组仅接受 `text` part；`image_url` 等返回 `400`。 |
| **模型路由** | `/v1/models` 只广告 `model` 配置项指定的单个 id；请求 `model` 仅作为字符串传入会话，无真实模型目录/路由。 |
| **Responses API** | 仅子集：`input`（字符串/数组）、`instructions`、`stream`、`max_output_tokens`、`stream_options.include_usage`；`previous_response_id` 被接受但忽略（粘性会话即存储）；无 `include` / `tools` / 多输出项。 |

> 把本端点当作「内部聊天 / 简单问答」用时，开箱即用；当作「通用 LLM 替代端点」使用前，请先确认上游客户端不会发送上述被拒绝的参数（尤其 `tools` 与 `temperature`）。

## 鉴权与信任

- 设置了 `apiKeys`：需要精确的 `Authorization: Bearer <key>`，匹配到的 key 即租户。
- 未设置 `apiKeys`：仅服务 **本机回环** 调用者（这是在参考实现基础上的刻意加固，避免误绑局域网端口后暴露未鉴权的 agent 访问）。
- 其它 Origin 的浏览器跨域调用被拒绝，除非列入 `allowedOrigins` 或携带有效密钥。三条路径都响应 `OPTIONS` 预检。

## 本地开发

```sh
node --check lib/index.js     # 语法检查
node test/smoke.mjs           # 基于假 agents 服务的协议测试
```
