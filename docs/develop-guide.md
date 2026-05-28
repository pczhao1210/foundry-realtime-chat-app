# Realtime 开发指南（总览）

该指南已拆分为两份并行文档，格式一致，都包含：

- 流程图
- 节点逐步说明（每个节点做什么）
- 对应代码片段
- 参数配置示例

## 开发文档入口

- [WebSocket 开发指南](develop-guide-websocket.md)
- [WebRTC 开发指南](develop-guide-webrtc.md)

## 适用模型

- `gpt-realtime-2`（conversation）
- `gpt-realtime-translate`（translation）
- `gpt-realtime-whisper`（transcription）

## 共用配置建议

```bash
export RT_PROVIDER=azure
export RT_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com"
export RT_API_VERSION="2025-04-01-preview"
export RT_AUTH_MODE="api-key"
export OPENAI_API_KEY="..."
```

若用本地配置文件，也可在 `config/config.json` 里设置：

- `realtime.apiKey`
- `realtime.apiKeyEnv`

## 选型建议

- 先用 WebSocket 跑通最小链路（排错简单）。
- 再切 WebRTC 做低延迟音频与端到端体验。
- 转写任务可以把输入语言作为可选 hint；翻译任务优先只声明目标语言。Azure Realtime translations 当前不接受源语言字段，源语言由服务自动识别。

## 工具能力说明

两份子文档都包含 MCP 与 Web Search 的接入流程、工具事件处理和补发 `response.create` 的策略.
