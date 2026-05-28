# 项目概览与运行配置

一个 Express + 原生 JavaScript 的 Realtime 语音示例，支持 Azure/OpenAI Realtime 对话、实时转写、实时翻译、原生 Web Search 和远程 MCP 工具。

## 功能

- 创建实时会话：后端调用 Realtime Session 接口生成临时会话信息
- WebSocket、WebRTC 或本地服务器代理连接
- 文本输入/输出流式展示
- 麦克风录音与实时音频播放
- 简单的频谱/音量可视化
- 实时对话、实时转写、实时翻译、Azure 认知服务四种任务类型
- 可在前端面板通过下拉选择模型和音色，并动态调整温度、Max Tokens
- 原生 Web Search 与远程 MCP 工具配置

## 目录结构

```text
config/config.json              # 本地配置文件，包含模型、端口和密钥引用
config/config.example.json      # 安全模板
server/index.js                 # Express + 可选 WebSocket 中继
public/index.html               # 前端页面
public/app.js                   # 前端逻辑
docs/                           # 项目说明文档
package.json                    # Node.js 依赖和脚本
```

## 准备

1. Node.js >= 18
2. 复制本地配置模板：

```bash
cp config/config.example.json config/config.json
cp config/mcp_config.example.json config/mcp_config.json
```

3. 配置 API key。推荐使用环境变量，并让 `config/config.json` 中的 `realtime.apiKeyEnv` 指向该变量名，默认是 `OPENAI_API_KEY`：

```bash
export OPENAI_API_KEY="sk-xxxx"
```

仅本地调试时，也可以直接把 key 写入 `config/config.json` 的 `realtime.apiKey` 字段：

```json
{
	"realtime": {
		"authMode": "api-key",
		"apiKey": "sk-xxxx",
		"apiKeyEnv": "OPENAI_API_KEY"
	}
}
```

`config/config.json` 已被 `.gitignore` 忽略；不要把真实 key 写入 `config/config.example.json`、README、docs 或任何会提交的文件。生产环境优先使用环境变量、managed identity 或服务端托管的凭据流。

## 安装与运行

```bash
npm install
npm run dev
```

浏览器访问: http://localhost:3000

## 使用

1. 打开页面后，点击“连接”会先向后端请求 `/api/realtime-session` 创建会话。
2. 选择 WebSocket 或 WebRTC 连接方式。
3. 点击“开始说话”打开麦克风；停止后按当前任务类型处理语音流。
4. 实时对话任务可输入文本并点击“发送文本”。
5. 流式返回内容会在日志区显示，音频会直接播放。

## 配置

`config/config.json` 中可调整：

- `provider` / `model` / `deployment` / `endpoint`
- `authMode` (`api-key` or `managed-identity`) / `apiKey` / `apiKeyEnv` / `azure.authScope` / `azure.managedIdentityClientId`
- `voice` / `modalities` / `temperature` / `max_response_output_tokens`
- `speech`：Azure 认知服务转写配置，包含 `provider`, `region`, `authMode`, `apiKeyEnv`, `language`, `resourceId`
- `web_search`：Foundry/OpenAI 原生 `web_search` hosted tool，默认关闭
- `system_prompt`：Realtime instructions，默认按 Realtime prompting guide 拆成多个短段落
- `speech_style_instructions`：实时对话的语音风格补充指令
- `server.port` / `server.clientOrigin`

修改配置后重启服务器生效。

Azure 认知服务转写使用独立的 `speech` 配置，不复用 Realtime deployment。推荐把 Speech/Cognitive Services key 放在环境变量中：

```bash
export AZURE_SPEECH_KEY="..."
RT_SPEECH_PROVIDER=azure-cognitive RT_SPEECH_REGION=eastus ./start.sh
```

前端“任务类型”选择“Azure认知服务”后，会调用 `/api/speech-token` 获取短期 token，再由 Azure Speech SDK 进行连续识别。该任务不创建 Realtime 会话，不支持 MCP/Web Search；输出可选“转写文本”或“翻译文本”，输入语言可保持自动，翻译文本时再选择目标语言。
如果 `speech.authMode` 使用 `managed-identity`，还需要配置 Speech/Cognitive Services 资源 ID（`speech.resourceId` 或 `RT_SPEECH_RESOURCE_ID`），用于生成 Speech SDK 需要的 Entra token 格式。
音频文件转写同样走 Azure Speech SDK：选择“Azure认知服务”任务后上传文件，浏览器会把支持的音频解码并转换成 WAV 后转写，不依赖 Realtime 连接。

前端音色下拉内置 `alloy`、`ash`、`ballad`、`coral`、`echo`、`sage`、`shimmer`、`verse`。服务端会把本地配置中的自定义音色并入安全配置并校验前端传入值。

## Azure 认证

- `api-key` 模式使用 `api-key` 请求头创建 Realtime session，适合本地调试。
- `managed-identity` 模式由服务端使用 Azure Identity 获取 bearer token，并通过 `Authorization: Bearer <token>` 调用 Azure Realtime API。
- 连接前会调用 `/api/realtime-auth-validation` 做认证校验。API key 模式只返回是否存在密钥，managed identity 模式只校验能否获取 Entra token，不会把长期密钥或 bearer token 发给浏览器。
- WebSocket 在 `api-key` 模式下可直连调试；在 `managed-identity` 模式下会自动使用本地 `/realtime-proxy` 代理，由服务端用 Entra token 连接 Azure。

## 任务类型

- 实时对话：模型下拉使用 `gpt-realtime-1`、`gpt-realtime-1.5`、`gpt-realtime-2`。
- 实时转写：模型下拉使用 `gpt-realtime-whisper`。
- 实时翻译：模型下拉使用 `gpt-realtime-translate`。

音色只在实时对话和实时翻译任务显示；输入语言只在转写/翻译显示，目标语言只在翻译显示。输入语言是能力提示，不是所有任务都会发送：转写任务可把它作为 `audio.input.transcription.language` 的可选提示；OpenAI 翻译通常自动识别源语言；Azure Realtime translations 当前拒绝 `session.audio.input.transcription.language`，所以界面会禁用该下拉并提示由服务自动识别。服务端会校验传入的模型/部署名和音色，避免手动输入拼写错误。

实时对话没有文档化的输出语言标签可配置项。如果中文听起来像外国人说中文，优先尝试不同内置音色，并通过 `system_prompt` 或 `speech_style_instructions` 明确要求“标准普通话、自然四声、中文语义断句”。这类提示能改善韵律，但不能等同于专用中文 TTS voice。

Realtime 转写按官方 GA 协议使用 `session.type="transcription"`，`audio.input.transcription.model` 指向 `gpt-realtime-whisper` 部署，并省略/禁用 VAD 后手动提交音频。OpenAI 文档中 `audio.input.transcription.language` 是 optional language hint，例如 `en` 或 `zh`，不是必填项。Azure 当前对 `gpt-realtime-whisper` 的普通 WebSocket `/realtime` 握手可能返回 `OpperationNotSupported`，浏览器路径会优先使用 GA WebRTC `client_secrets` / `calls`。

Realtime 翻译按官方协议是独立 session：WebSocket 使用 `/realtime/translations`，WebRTC 使用 `/realtime/translations/client_secrets` 和 `/realtime/translations/calls`；翻译流不发送 `response.create`，而是处理 `session.output_audio.delta`、`session.output_transcript.delta` 和 `session.input_transcript.delta`。官方翻译示例只配置 `audio.output.language` 作为目标语言；如需源转写字幕，可在 translation `session.update` 中启用 `audio.input.transcription` 并提供转写模型。Azure 当前接受 `model:gpt-realtime-whisper`，但会拒绝 `audio.input.transcription.language`，所以源语言由服务端自动识别。

## 工具配置

- Microsoft Foundry OpenAI/Responses API 已支持原生 `web_search` tool；本示例在主界面提供“原生 Web Search”开关，并支持 `config/config.json` 里的 `realtime.web_search` 或 `RT_WEB_SEARCH=true` 开启。
- Realtime 路径下 hosted tool 支持会随 Azure API 版本变化，若返回 `unknown_parameter` 或工具类型错误，请先关闭该开关并使用 MCP 搜索工具兜底。
- MCP 配置页支持 `server_description`、`project_connection_id`、`allowed_tools`、`require_approval` 和自定义 headers。鉴权会去重，OpenAI 官方路径使用顶层 `authorization`，当前实测 Azure Realtime 导入远程 MCP 需要 `headers.Authorization`。

## 注意事项

- 生产环境不要下发长期 API Key；优先使用 server-created ephemeral credentials、本地代理或 managed identity。
- Realtime、MCP 和 hosted tools 的字段支持会随模型/API 版本变化；遇到 `unknown_parameter` 时先缩小 payload 再逐步恢复。

## 授权

示例代码供演示与学习，可自由修改使用。