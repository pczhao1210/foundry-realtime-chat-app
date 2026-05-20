# 实时对讲网页应用 (GPT Realtime)

一个最小可运行的实时对讲/语音 + 文本双模网页示例，后端用 Express，前端使用原生 JS，通过 OpenAI 的 *gpt-4o-realtime*（或未来的 gpt-realtime / 4o-realtime 系列）模型进行低延迟交互。

> 说明：本项目示例性展示端到端结构。具体事件名称、音频处理方式随着官方接口迭代可能有所差异，请根据你使用时的最新文档调整。

## 功能
- 创建实时会话：后端调用 Realtime Session 接口生成临时会话信息
- WebSocket 直连或服务器中继两种模式
- 文本输入/输出流式展示（response.output_text.delta）
- 麦克风录音，分片发送 (input_audio_buffer.append -> commit -> response.create)
- 简单的频谱/音量可视化
- 语音 + 文本双模请求
- 可在前端面板通过下拉选择模型，并动态调整温度、Max Tokens、Voice

## 目录结构
```
config/config.json        # 配置文件（模型、端口等）
server/index.js           # Express + 可选 WS 中继
public/index.html         # 前端页面
public/app.js             # 前端逻辑
package.json              # 依赖
README.md
```

## 准备
1. Node.js >= 18
2. 设置环境变量（与 config.json 中 realtime.apiKeyEnv 对应，默认 OPENAI_API_KEY）：

```bash
export OPENAI_API_KEY="sk-xxxx"
```

## 安装与运行
```bash
npm install
npm run dev
```
浏览器访问: http://localhost:3000

## 使用
1. 打开页面后，点击 “连接” 会先向后端请求 `/api/realtime-session` 创建会话
2. 选择直连或服务器中继：
   - 直连：浏览器直接使用服务端返回的会话密钥/URL 建立 WebSocket
   - 中继：浏览器 WS -> 自己服务器 -> OpenAI
3. 点击 “开始说话” 录音；停止后自动发送一个响应请求
4. 输入文本 Ctrl+Enter 或点击 “发送文本” 触发文本对话
5. 流式返回内容会在日志区显示，完成后会固化为一条消息

## 配置
本地运行前可从模板复制配置文件：

```bash
cp config/config.example.json config/config.json
cp config/mcp_config.example.json config/mcp_config.json
```

`config/config.json` 中可调整：
- provider / model / endpoint
- authMode (`api-key` or `managed-identity`) / deployment / azure.authScope / azure.managedIdentityClientId
- voice / modalities / temperature / max_response_output_tokens
- web_search (Foundry/OpenAI 原生 `web_search` hosted tool，默认关闭)
- system_prompt (instructions)
- server.port / server.clientOrigin

修改后重启服务器生效。

Azure 认证说明：
- `api-key` 模式继续使用 `api-key` 请求头创建 realtime session，适合本地调试。
- `managed-identity` 模式会由服务端使用 Azure Identity 获取 bearer token，并通过 `Authorization: Bearer <token>` 调用 Azure Realtime session API。
- 连接前会调用 `/api/realtime-auth-validation` 做认证校验：API key 模式只返回是否存在密钥，managed identity 模式只校验能否获取 Entra token，不会把长期密钥或 bearer token 发给浏览器。
- `WebSocket` 直连调试仍依赖 `/api/realtime-ws-key`，因此不支持 `managed-identity` 模式；此模式下请使用 `WebRTC` 路径。
- 前端模型下拉内置 `gpt-realtime-1`、`gpt-realtime-2`、`gpt-realtime-translation`、`gpt-realtime-whisper`，服务端会校验传入的模型/部署名，避免手动输入拼写错误。

工具配置说明：
- Microsoft Foundry OpenAI/Responses API 已支持原生 `web_search` tool；本示例在主界面提供 “原生 Web Search” 开关，并支持 `config/config.json` 里的 `realtime.web_search` 或 `RT_WEB_SEARCH=true` 开启。Realtime 路径下 hosted tool 支持会随 Azure API 版本变化，若返回 `unknown_parameter` 或工具类型错误，请先关闭该开关并使用 MCP 搜索工具兜底。
- MCP 配置页支持 `server_description`、`project_connection_id`、`allowed_tools`、`require_approval` 和自定义 headers；工具 payload 统一通过 `headers.Authorization` 传鉴权信息，避免同时发送重复的 `authorization` 字段。

## 注意事项 / 待改进
- 音频播放：示例中对 `response.audio.delta` 及二进制音频未做完整解码（需了解官方返回格式是 PCM 还是 Opus）
- 安全：生产环境不应下发长期 API Key；需使用短期/ephemeral token 机制
- 断线重连与状态恢复未完善
- 日志与错误处理可进一步增强

## 下一步可扩展
- 使用 Web Audio 解码实时音频并播放
- 增加对讲模式（持续监听 VAD 自动开关发送）
- 增加多房间、多用户标识 (roomId / userId)
- 前端使用框架（React/Vue/Svelte）与状态管理
- 引入 Service Worker 做离线与缓存
- 增加鉴权 (JWT) 以及速率限制

## 授权
示例代码供演示与学习，可自由修改使用。
