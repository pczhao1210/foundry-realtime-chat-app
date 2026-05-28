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

## Azure 认知服务转写

页面的“任务类型”下拉可选择“Azure认知服务”。本地运行时配置 Speech/Cognitive Services 区域和密钥即可：

```bash
export AZURE_SPEECH_KEY="你的 Speech 或 Cognitive Services key"
RT_SPEECH_PROVIDER=azure-cognitive RT_SPEECH_REGION=eastus ./start.sh
```

也可以在 `config/config.json` 的 `speech` 节设置 `provider`, `region`, `apiKeyEnv`, `language` 等字段。服务端只向浏览器下发短期 Speech token，不会暴露长期 key。
如果使用 managed identity，还需要设置 `speech.resourceId` 或 `RT_SPEECH_RESOURCE_ID`。

选择“Azure认知服务”任务后，页面会显示“输出”选项、输入语言、麦克风和“音频文件”上传入口。输出可选择“转写文本”或“翻译文本”；输入语言可保持自动，翻译文本时再选择目标语言。常见音频格式会先在浏览器中解码并转换成 Speech SDK 可识别的 WAV，再发送到 Azure Speech 处理；这条路径不需要先连接 Realtime 会话，也不支持 MCP/Web Search。
