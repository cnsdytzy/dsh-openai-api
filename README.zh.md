# @huyang2024/dsh-openai-api

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供标准 OpenAI 兼容 HTTP 接口的插件。安装到 dsh 配置（profile）后，harness 的 Web 服务会额外提供：

| 接口 | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | Chat Completions API（流式 / 非流式），支持 function/tool 调用 |
| `POST /v1/responses` | Responses API 子集（流式 / 非流式），无状态 + `previous_response_id` 续聊缓存 |
| `GET /v1/models` | 汇总所有已注册 provider 的模型目录 |

生成由 harness 的 `llm` 运行时完成：请求会用当前部署配置的 provider/model 应答（Web「模型」设置页写入，经 `agentDefaultModel.currentSelection()` 读取）。

## 安装

任意机器：

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
        apiKey: ''            # 可选 Bearer 密钥；留空则仅允许本机回环访问
        pathPrefix: '/v1'     # 可选，默认值如此
        maxBodyBytes: 33554432
        allowedOrigins: []    # 额外允许跨域的精确 Origin 列表
```

重启 profile 使新行生效。

## 鉴权与信任

- 设置了 `apiKey`：所有请求必须携带 `Authorization: Bearer <key>`（恒定时间比较）。
- 未设置 `apiKey`：仅服务本机回环调用者；远程调用返回 `403 unauthorized_remote`，避免误绑局域网端口后暴露未鉴权的模型访问。
- 来自其它 Origin 的浏览器跨域调用被拒绝，除非出现在 `allowedOrigins` 或携带有效密钥；同源页面直接放行。三条路径都响应 `OPTIONS` 预检。

## 模型路由

请求中的 `model` 字段按以下顺序解析：

1. 形如 `"provider/model"` 且该 provider 路由存在的组合；
2. 在某个已注册 provider 的模型目录中能找到的 id（60 秒参考缓存）；
3. 否则原样传给默认 provider。

不传 `model` 时使用部署默认选择，不做任何改写。

## 请求支持说明

Chat Completions：`messages`（system/developer/user/assistant/tool）、字符串或分块内容、`tools` 与工具调用往返（`tool_calls` ↔ `role:'tool'` 结果）、`temperature`、`max_tokens`/`max_completion_tokens`、`stop`（≤ 4 个）、`stream`、`stream_options.include_usage`、`n = 1`。provider 输出思考内容时，流式 delta 会附带 `reasoning_content`（DeepSeek 风格）。

Responses：字符串或条目数组的 `input`（`message`、`function_call`、`function_call_output`；也接受裸 `{role,content}`）、`instructions`、`tools`（扁平函数定义）、`previous_response_id` 续聊（进程内存缓存，FIFO 上限 200）、完整的规范事件序列并以 `response.completed` 收尾。

`tool_choice: "none"` 会退化为完全不传工具；其他取值（包括 `{type:'function'}` 强制指定函数）一律按 auto 处理。

不支持项（可识别的会明确报错，其余忽略）：图像/音频输入、`logprobs`、`n > 1`。`response_format json_object/json_schema` 以指令提示方式降级实现，而非协议级强制。

## 本地开发

```sh
node --check lib/index.js     # 语法检查
node test/smoke.mjs           # 基于 stub 运行时的协议测试，无需网络
```
