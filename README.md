# Accio Switch

Mac 桌面应用：给 Accio Desktop 切换 OpenCode Go / 自定义 OpenAI 兼容 API，或切回官方积分模型。

界面仿 CC Switch 的供应商卡片与一键启用，不是 CC Switch 的 fork。当前状态与后续边界见 [任务交接.md](任务交接.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 当前状态：0.1.3

用户已在真实 Accio App 中验证：DeepSeek 预设填写 Key、保留 Chat Completions，可以正常收到文字回复。图片功能暂缓，保留已有实现，不进行真实生图验收。其他供应商、真实 Responses、完整工具任务及超长研究尚未全面验收。

配置界面明确使用完整请求地址，切换协议自动替换标准路径；保存前提示 Anthropic 接口、基础地址及明显的协议不匹配。当前不支持 Anthropic Messages。

## 0.1.2 供应商预设

内置 OpenCode Go（DeepSeek V4）、OpenAI（GPT-4.1 Mini / GPT-4.1）、DeepSeek（V4 Flash / Pro）、通义千问（北京，Qwen3.8 Max）、智谱（通用 API，GLM-5.3）和 Moonshot（Kimi K3）。预设不迁移旧配置；编辑旧供应商保留原地址、模型与凭据。

通义 Key 必须匹配北京地域；智谱此预设不是 Coding Plan 接口。OpenAI API 与 ChatGPT 订阅分别计费。预设依据官方文档填写；DeepSeek 默认文字对话已由用户实测，其他预设仍以本地验证为限。

接口参考：[OpenCode Go](https://opencode.ai/docs/go/)、[OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode)、[百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[智谱](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)、[Kimi](https://platform.moonshot.cn/docs/guide/use-thinking-models)。

## 0.1.1 界面更新

重新设计应用与托盘图标，统一深色薄荷绿界面。正文使用系统字体 14px，辅助文字不小于 12px；标题栏支持拖动。供应商配置选择和本地通道状态分开显示，编辑弹窗支持键盘操作和小窗口滚动。

## 安装与运行

- 当前安装包仅支持 Apple Silicon（arm64）、macOS 13.5 或更新版本，需已安装 `/Applications/Accio.app`。
- 打开 dmg，将 **Accio Switch.app** 拖到 Applications，再从 Finder 启动。
- 安装包内置官方 **Node v24.20.0**，无需系统 Node、Rust、pnpm 或开发终端。
- 当前使用本地 ad-hoc 签名保证包内资源完整性，没有 Developer ID 签名和 Apple 公证，不作为已公证公开发行版。
- 旧开发中继若仍占用 18765/18767，安装版会提示端口占用，不会任意杀进程。先退出旧实例；无法确认归属的进程应由用户关闭。

## 用法

1. 点击「添加供应商」，选择预设后填写 API Key 并保存，再点击「启用」。默认模型、接口和协议已填好，可在模型下拉或高级设置调整。自定义 API 仍支持 Chat Completions / Responses。
2. 点击「启用」，启动本地中继并设置 `GATEWAY_BASE_URL=http://127.0.0.1:18767`。
3. 切换前 Accio 已连接中继时，只重启中继；当前进行中的请求可能中断，请尽量在任务间切换。未连接时才启动或重启 Accio。
4. 自定义模式的生图使用单独「图片通道」；关闭时返回中文配置错误。图片 Key 可独立配置，留空复用对话 Key。官方模式的图片仍走官方。
5. 关闭窗口保留托盘；托盘可打开窗口、切供应商和退出。重复启动会显示现有窗口。
6. 退出应用会停止本实例的中继并清理本实例设置的网关环境；Accio 仍连接时会重启使其恢复官方连接。

## 路由与配置

- `127.0.0.1:18767`：网关中继。自定义模式把已知/探测到的 LLM 和图片路径转到 `127.0.0.1:18765`。
- `127.0.0.1:18765`：模型桥，转换 Chat Completions、Responses 与图片请求，转发推理帧并每 12 秒发送 SSE 心跳。
- Skill / MCP / Plugin / Connector 运行时请求转发 Accio 本地 `4097`；其余未知 API 默认反代 `https://phoenix-gw.alibaba.com`。
- 官方模式的模型、图片及模型目录转发官方，运行时请求仍走本地 `4097`。
- 配置与日志：`~/.accio-switch/`；Key 保存在 `keys/`（文件权限 0600）并同步钥匙串。文件中的最新保存值优先，钥匙串用于缺少文件时回退；OpenCode Go 还支持既有 auth.json 回退。
- 不修改 Accio asar。Accio 升级后路径可能变化，真实上游兼容性需重新验收。

## 开发与打包

开发依赖 Node、pnpm、Rust 和 macOS Command Line Tools。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm tauri build
```

发布构建自动运行 `scripts/prepare-node.sh`，从 nodejs.org 下载固定 arm64 运行时，校验 SHA-256 并打包 Node 许可。下载缓存及运行时不入 Git。应用使用包内绝对路径启动 Node，并清除继承的 `NODE_OPTIONS` / `NODE_PATH`。

产物位于 `src-tauri/target/release/bundle/macos/` 和 `src-tauri/target/release/bundle/dmg/`。

## 本地验证

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
node --check sidecar/gateway-relay.cjs
node --check sidecar/openai-bridge.cjs
TEST_NODE="$PWD/src-tauri/runtime/node" node --test tests/sidecars.test.cjs
# 此测试命令需要支持直接运行 TypeScript 的 Node 24
node --test tests/presets.test.cjs tests/provider-endpoint.test.mjs
```

协议测试使用临时配置、随机端口、本地模拟上游和虚构 Key，含 92 秒静默测试，不调用付费服务。模拟结果不能替代 Accio Design、生图、真实 Responses 或真实长研究验收。

桌面验收专用环境：设置 `ACCIO_SWITCH_TEST_DIR` 为独立绝对目录，并同时设置 `ACCIO_SWITCH_TEST_RELAY_PORT`、`ACCIO_SWITCH_TEST_BRIDGE_PORT`。此模式不访问钥匙串、OpenCode 凭据、Accio asar，不修改 launchctl 或启动/重启 Accio；通过 `ACCIO_ORIGINAL_GATEWAY_URL`、`ACCIO_LOCAL_GATEWAY_URL` 和测试供应商配置指向本地模拟服务。正常使用不要设置这些变量。

Windows、Intel、自启、自动更新及签名公证留待后续；新图标已完成。
