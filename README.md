# AC-Switch

Mac / Windows 桌面应用：给 Accio Desktop 切换 Novaferry、OpenCode Go 等 OpenAI 兼容 API，或切回官方积分模型。

界面仿 CC Switch 的供应商卡片与一键启用，不是 CC Switch 的 fork。版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 当前状态：0.1.6

内置 [Novaferry](https://novaferry.com/) 供应商：固定显示在供应商列表里，填入 Novaferry 控制台创建的 API Key 即可启用，一个 Key 可调用 GPT 和 Claude 系列在售模型。Novaferry 不能删除，名称和接口地址固定，模型、思考强度和协议可以调整；卡片上的「官网」按钮会打开 Novaferry 首页。

应用换用新图标，菜单栏托盘图标同步更新。

## 0.1.5 更新

修复 Accio gzip 压缩请求被当作 JSON 解析的问题。网关转发保留压缩头与原始数据，模型桥解压后转换请求；压缩前后的请求大小均限制为 32 MiB。

自定义 API 新增中（`medium`）和极高（`xhigh`）思考强度，标签简化为关闭、低、中、高、极高、最强。OpenAI Chat Completions 与 Responses 原样传递所选强度，不再将 `max` 降为 `high`；实际支持由模型和代理决定。Responses 下关闭选项仅省略强度参数，可能使用模型默认值，不保证关闭思考。

启动、状态检查与供应商操作移至后台执行；状态轮询等待上次完成后再继续，避免请求堆积。

用户已在真实 Accio App 中验证：DeepSeek 预设填写 Key、保留 Chat Completions，可以正常收到文字回复。图片功能暂缓，保留已有实现，不进行真实生图验收。其他供应商、真实 Responses、完整工具任务及超长研究尚未全面验收。

配置界面明确使用完整请求地址，切换协议自动替换标准路径；保存前提示 Anthropic 接口、基础地址及明显的协议不匹配。当前不支持 Anthropic Messages。

## 0.1.2 供应商预设

0.1.6 起另有内置的 Novaferry 供应商，见上文。

内置 OpenCode Go（DeepSeek V4）、OpenAI（GPT-4.1 Mini / GPT-4.1）、DeepSeek（V4 Flash / Pro）、通义千问（北京，Qwen3.8 Max）、智谱（通用 API，GLM-5.3）和 Moonshot（Kimi K3）。预设不迁移旧配置；编辑旧供应商保留原地址、模型与凭据。

通义 Key 必须匹配北京地域；智谱此预设不是 Coding Plan 接口。OpenAI API 与 ChatGPT 订阅分别计费。预设依据官方文档填写；DeepSeek 默认文字对话已由用户实测，其他预设仍以本地验证为限。

接口参考：[OpenCode Go](https://opencode.ai/docs/go/)、[OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode)、[百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[智谱](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)、[Kimi](https://platform.moonshot.cn/docs/guide/use-thinking-models)。

## 0.1.1 界面更新

重新设计应用与托盘图标，统一深色薄荷绿界面。正文使用系统字体 14px，辅助文字不小于 12px；标题栏支持拖动。供应商配置选择和本地通道状态分开显示，编辑弹窗支持键盘操作和小窗口滚动。

## 安装与运行

- 当前安装包仅支持 Apple Silicon（arm64）、macOS 13.5 或更新版本，需已安装 `/Applications/Accio.app`。
- 打开 dmg，将 **AC-Switch.app** 拖到 Applications，再从 Finder 启动。
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
- 配置与日志：`~/.ac-switch/`；Key 保存在 `keys/`（文件权限 0600）并同步钥匙串。文件中的最新保存值优先，钥匙串用于缺少文件时回退；OpenCode Go 还支持既有 auth.json 回退。
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

桌面验收专用环境：设置 `AC_SWITCH_TEST_DIR` 为独立绝对目录，并同时设置 `AC_SWITCH_TEST_RELAY_PORT`、`AC_SWITCH_TEST_BRIDGE_PORT`。此模式不访问钥匙串、OpenCode 凭据、Accio asar，不修改 launchctl 或启动/重启 Accio；通过 `ACCIO_ORIGINAL_GATEWAY_URL`、`ACCIO_LOCAL_GATEWAY_URL` 和测试供应商配置指向本地模拟服务。正常使用不要设置这些变量。

Windows、Intel、自启、自动更新及签名公证留待后续；新图标已完成。

## Windows x64 开发与验收（尚未发布）

Windows 适配源代码已加入，安装包必须在 Windows 上构建。当前尚未通过 Windows 编译及真实 Accio 验收，已发布 Mac 0.1.3 不代表 Windows 可用。

- 系统目标：Windows 11 x64（首轮验收），先安装 Windows Accio。
- 内置 Node v24.20.0 win-x64，由 `scripts/prepare-node.ps1` 固定 SHA-256 校验并附带许可；Tauri 自动合并 `tauri.windows.conf.json`，生成当前用户 NSIS 安装程序。
- 凭据使用当前 Windows 用户的 DPAPI 加密，不能直接复制 Mac 的 Key 文件。首次使用请重新填写 Key。
- 检查常见安装目录与卸载注册表的 InstallLocation；自定义路径可用 `AC_SWITCH_ACCIO_PATH` 指向 `Accio.exe`。
- 网关变量只传给 Switch 启动的 Accio，不设置全局环境变量。Accio 已运行但未连接中继时尝试正常关闭；无法退出会提示手动退出，不强杀。
- Windows 不清理未知或孤儿监听进程；端口冲突提示用户退出旧实例。关闭 Switch 窗口仍保留托盘。
- 未进行 Windows 代码签名，分发前需说明 SmartScreen 提示；不应关闭系统安全防护。

仓库工作流 **Windows x64 build** 仅支持手动触发（Actions → Run workflow），运行 Rust 测试、DPAPI 加解密测试、Node 本地协议测试并生成 `AC-Switch-Windows-x64` artifact。不会自动发布 Release。

本机 Windows 构建需要 Node 24、pnpm 10、Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2；普通使用者安装打包后的程序即可，无需这些开发工具。

```powershell
pnpm install --frozen-lockfile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-node.ps1
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
pnpm tauri build
```

拿到安装包后，先用临时配置/虚构 Key 验证启动、保存、端口冲突和退出；真实模型验收由用户使用自己的 Key 进行，先验证 DeepSeek 普通文字回复。特别确认 Windows Accio 会读取子进程环境中的 GATEWAY_BASE_URL；未经实测不认定该路径可用。图片仍暂缓。

## 许可证

本项目以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）开源。修改后分发，或通过网络向他人提供修改版服务，需以同一许可证公开对应源代码。

本项目与阿里巴巴 / Accio 官方无关。使用第三方模型 API 时，请自行遵守 Accio 及各供应商的服务条款。
