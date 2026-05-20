# 实时语音对话示例 (GPT Realtime)

一个 Express + 原生 JavaScript 的 Realtime 语音示例，支持 Azure/OpenAI Realtime 对话、实时转写、实时翻译、原生 Web Search 和远程 MCP 工具。

所有项目说明文档集中在 [docs/](docs/) 中：

- [项目概览与运行配置](docs/overview.md)
- [Realtime 开发指南（总览）](docs/develop-guide.md)
- [Realtime 开发指南 - WebSocket](docs/develop-guide-websocket.md)
- [Realtime 开发指南 - WebRTC](docs/develop-guide-webrtc.md)
- [gpt-realtime-2 WebSocket/WebRTC 连接配置](docs/realtime-2-websocket-webrtc.md)
- [Realtime 工具与 MCP 调用流程](docs/realtime-tools-mcp-flow.md)

快速启动：

```bash
npm install
npm run dev
```

浏览器访问: http://localhost:3000

## Key 配置

本地运行前复制配置模板：

```bash
cp config/config.example.json config/config.json
cp config/mcp_config.example.json config/mcp_config.json
```

推荐把 API key 放在环境变量中，并让 `config/config.json` 的 `realtime.apiKeyEnv` 指向该变量名：

```bash
export OPENAI_API_KEY="sk-xxxx"
```

仅本地调试时，也可以直接在 `config/config.json` 里填写 `realtime.apiKey`。该文件已被 `.gitignore` 忽略，不要把真实 key 写入 `config/config.example.json` 或提交到仓库。
