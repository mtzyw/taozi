#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/admin-web/local-runtime.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "未找到本地配置文件：$CONFIG_FILE"
  echo "请先执行：cp admin-web/local-runtime.sample.conf admin-web/local-runtime.conf"
  echo "然后打开 admin-web/local-runtime.conf 填写微信、地图、云打印参数。"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a

cd "$ROOT_DIR"
node --no-warnings=ExperimentalWarning admin-web/server.js
