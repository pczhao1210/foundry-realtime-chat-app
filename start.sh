#!/usr/bin/env bash
# 启动脚本：支持通过参数或环境变量覆写 realtime 配置
# 用法示例：
#   ./start.sh --model gpt-realtime-1 --temperature 0.6 --port 4000 --endpoint https://api.openai.com/v1/realtime --key-env OPENAI_API_KEY
#   RT_MODEL=gpt-realtime-2 RT_TEMPERATURE=0.5 ./start.sh

set -euo pipefail

# 默认值（可被 config/config.json 覆盖；这里仅供帮助输出，不做最终赋值）
MODEL_DEFAULT=""
ENDPOINT_DEFAULT=""
VOICE_DEFAULT=""
PORT_DEFAULT=""

show_help() {
  cat <<EOF
启动实时对讲服务

参数 (--key value)：
  --provider <name>        默认: openai | azure
  --auth-mode <mode>       api-key | managed-identity
  --model <modelName>
  --deployment <name>      Azure deployment name，默认跟随 model
  --endpoint <url>
  --api-version <ver>      Azure 时需要
  --key-env <ENV_NAME>     指定读取的 API Key 环境变量名 (默认 OPENAI_API_KEY)
  --azure-client-id <id>   user-assigned managed identity client ID
  --azure-auth-scope <s>   默认: https://cognitiveservices.azure.com/.default
  --voice <voiceName>
  --modalities <list>      逗号分隔, 例如: text,audio
  --temperature <float>
  --max-tokens <int>
  --system-prompt <text>
  --port <number>          覆盖 server.port
  --debug <true|false>
  --force-kill           若端口被占用，直接强制结束占用进程 (fallback)
  --help                   显示本帮助

也可通过环境变量：
  RT_PROVIDER, RT_AUTH_MODE, RT_MODEL, RT_DEPLOYMENT, RT_ENDPOINT, RT_API_VERSION, RT_KEY_ENV,
  RT_AZURE_CLIENT_ID, RT_AZURE_AUTH_SCOPE, RT_VOICE, RT_MODALITIES,
  RT_TEMPERATURE, RT_MAX_TOKENS, RT_SYSTEM_PROMPT, RT_PORT, RT_DEBUG

示例：
  RT_MODEL=gpt-realtime-1 RT_TEMPERATURE=0.4 ./start.sh
  ./start.sh --model gpt-realtime-2 --temperature 0.8 --debug true
EOF
}

# 解析参数
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)       export RT_PROVIDER="$2"; shift 2;;
    --auth-mode)      export RT_AUTH_MODE="$2"; shift 2;;
    --model)          export RT_MODEL="$2"; shift 2;;
    --deployment)     export RT_DEPLOYMENT="$2"; shift 2;;
    --endpoint)       export RT_ENDPOINT="$2"; shift 2;;
    --api-version)    export RT_API_VERSION="$2"; shift 2;;
    --key-env)        export RT_KEY_ENV="$2"; shift 2;;
    --azure-client-id) export RT_AZURE_CLIENT_ID="$2"; shift 2;;
    --azure-auth-scope) export RT_AZURE_AUTH_SCOPE="$2"; shift 2;;
    --voice)          export RT_VOICE="$2"; shift 2;;
    --modalities)     export RT_MODALITIES="$2"; shift 2;;
    --temperature)    export RT_TEMPERATURE="$2"; shift 2;;
    --max-tokens)     export RT_MAX_TOKENS="$2"; shift 2;;
    --system-prompt)  export RT_SYSTEM_PROMPT="$2"; shift 2;;
    --port)           export RT_PORT="$2"; shift 2;;
    --debug)          export RT_DEBUG="$2"; shift 2;;
  --force-kill)     export RT_FORCE_KILL=1; shift 1;;
    --help|-h)        show_help; exit 0;;
    *)                ARGS+=("$1"); shift;;
  esac
done

# 检查 node 是否存在
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未找到 node，请先安装 Node.js (>=18)" >&2
  exit 1
fi

# 如果没有安装依赖，尝试安装（无 npm 时提示）
if [ ! -d node_modules ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "[INFO] 检测到缺少 node_modules，自动执行 npm install" >&2
    npm install --no-audit --no-fund
  else
    echo "[WARN] 缺少 node_modules 且未找到 npm，跳过依赖安装" >&2
  fi
fi

# 必须的 API Key 环境变量存在性提示（使用 RT_KEY_ENV 或默认 OPENAI_API_KEY）
AUTH_MODE_RAW="${RT_AUTH_MODE:-api-key}"
case "$(printf '%s' "$AUTH_MODE_RAW" | tr '[:upper:]' '[:lower:]')" in
  managed-identity|managed_identity|msi|entra) AUTH_MODE="managed-identity";;
  *) AUTH_MODE="api-key";;
esac
export RT_AUTH_MODE="$AUTH_MODE"
KEY_ENV_NAME="${RT_KEY_ENV:-OPENAI_API_KEY}"
if [[ "$AUTH_MODE" != "managed-identity" ]] && [ -z "${!KEY_ENV_NAME:-}" ]; then
  echo "[WARN] 环境变量 $KEY_ENV_NAME 未设置，实时会话创建将失败" >&2
fi

echo "[INFO] 启动服务: provider=${RT_PROVIDER:-} auth_mode=${AUTH_MODE} deployment=${RT_DEPLOYMENT:-} model=${RT_MODEL:-} endpoint=${RT_ENDPOINT:-} port=${RT_PORT:-}"

# 端口占用检测与释放
PORT_TO_USE="${RT_PORT:-}"
if [ -z "$PORT_TO_USE" ]; then
  # 尝试从 config/config.json 抓取 server.port (简单 grep, 不依赖 jq)
  if [ -f config/config.json ]; then
    PORT_TO_USE=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' config/config.json | head -n1 | grep -oE '[0-9]+') || true
  fi
fi
if [ -z "$PORT_TO_USE" ]; then
  PORT_TO_USE=3000
fi

echo "[INFO] 目标监听端口: $PORT_TO_USE"

find_pids() {
  # 返回占用端口的 PID 列表（空则无）
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT_TO_USE" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT_TO_USE" 2>/dev/null || true
  else
    echo ""  # 无工具，跳过
  fi
}

PIDS=$(find_pids)
if [ -n "$PIDS" ]; then
  echo "[WARN] 端口 $PORT_TO_USE 已被占用: $PIDS"
  echo "[INFO] 尝试发送 SIGTERM 以优雅关闭..."
  for p in $PIDS; do
    kill -SIGTERM "$p" 2>/dev/null || true
  done
  # 等待最多 3 秒
  for i in 1 2 3; do
    sleep 1
    STILL=$(find_pids)
    [ -z "$STILL" ] && break
    echo "[INFO] 等待端口释放 ($i/3)..."
  done
  STILL=$(find_pids)
  if [ -n "$STILL" ]; then
    if [ -n "${RT_FORCE_KILL:-}" ]; then
      echo "[WARN] 仍被占用，使用 SIGKILL 强制结束: $STILL"
      for p in $STILL; do
        kill -9 "$p" 2>/dev/null || true
      done
      sleep 1
      FINAL=$(find_pids)
      if [ -n "$FINAL" ]; then
        echo "[ERROR] 强制结束后端口仍被占用，退出" >&2
        exit 1
      fi
    else
      echo "[ERROR] 端口仍被占用。若要强制结束可加入 --force-kill 参数" >&2
      exit 1
    fi
  fi
  echo "[INFO] 端口 $PORT_TO_USE 已释放"
fi

echo "[INFO] 启动 Node 服务器..."
exec node server/index.js
