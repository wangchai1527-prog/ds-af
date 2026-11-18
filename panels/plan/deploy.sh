#!/usr/bin/env bash
# Idea Plan 分析台（:8792）部署脚本 —— 工厂 deployTo 面板部署时执行（人点上线 = 重启授权）
# 用法：bash deploy.sh （在 panels/plan/ 目录下执行；PATH 需含 node，否则用 hermes node 兜底）
set -u
cd "$(dirname "$0")"
PORT="${PORT:-8792}"
if ! command -v node >/dev/null 2>&1; then
  export PATH="/home/administrator/.hermes/node/bin:$PATH"
fi
# 先杀旧监听（若无监听则跳过），再以 nohup 拉起；日志追加 logs_plan.log
OLD_PID=$(ss -tlnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLD_PID}" ]; then
  kill "${OLD_PID}" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ss -tlnp 2>/dev/null | grep -q ":${PORT}" || break
    sleep 0.5
  done
fi
nohup node plan-server.js >> logs_plan.log 2>&1 &
sleep 1
if ss -tlnp 2>/dev/null | grep -q ":${PORT}"; then
  echo "deploy OK: plan-server 已在 :${PORT} 监听（pid $(ss -tlnp | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1)）"
else
  echo "deploy WARN: :${PORT} 未监听 — 查 logs_plan.log" >&2
  exit 1
fi
