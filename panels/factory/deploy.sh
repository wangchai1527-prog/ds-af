#!/usr/bin/env bash
# Engineering 工厂面板（:8794）部署脚本 —— 与 panels/plan/deploy.sh 同款（工厂 📍 面板部署目标可指向本目录）
# 用法：bash deploy.sh （在 panels/factory/ 目录下执行；PATH 需含 node，否则用 hermes node 兜底）
set -u
cd "$(dirname "$0")"
PORT="${PORT:-8794}"
if ! command -v node >/dev/null 2>&1; then
  export PATH="/home/administrator/.hermes/node/bin:$PATH"
fi
# 先杀旧监听（若无监听则跳过），再以 nohup 拉起；日志追加 logs_factory.log
# 注意：正在执行的 run 是子进程（claude agent），server 重启不杀在跑节点（runFrom 由新进程经 /api/runs/open 恢复）
OLD_PID=$(ss -tlnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLD_PID}" ]; then
  kill "${OLD_PID}" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ss -tlnp 2>/dev/null | grep -q ":${PORT}" || break
    sleep 0.5
  done
fi
nohup node factory-server.js >> logs_factory.log 2>&1 &
sleep 1
if ss -tlnp 2>/dev/null | grep -q ":${PORT}"; then
  echo "deploy OK: factory-server 已在 :${PORT} 监听（pid $(ss -tlnp | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1)）"
else
  echo "deploy WARN: :${PORT} 未监听 — 查 logs_factory.log" >&2
  exit 1
fi
