# Accio Switch

Mac 桌面应用：给 Accio Desktop 切换 OpenCode Go / 自定义 OpenAI 兼容 API，或切回官方积分模型。

界面仿 CC Switch 的供应商卡片与一键启用，不是 CC Switch 的 fork。

## 风险

非官方社区工具。Accio 升级后 `GATEWAY_BASE_URL` 路径可能变化。请自行判断是否使用。

## 要求

- macOS
- Accio Desktop（`/Applications/Accio.app`）
- Node.js（用于本地中继）
- Rust / pnpm（仅开发）

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 用法

1. 添加 OpenCode Go 或自定义 API，把 Key 存进钥匙串。
2. 点「启用」，应用会启动本地中继并把 Accio 的 `GATEWAY_BASE_URL` 指到 `127.0.0.1:18767`。
3. Accio 会重启。Skill / MCP / 心跳仍转发官方网关。
4. 切回「Accio 官方原生认证」会清掉该环境变量。

## 原理

启动 Accio 时设置：

```text
GATEWAY_BASE_URL=http://127.0.0.1:18767
```

本地中继默认反代 `https://phoenix-gw.alibaba.com`，仅把

```text
POST /api/adk/llm/generateContent
```

转到 OpenAI 兼容上游。
