# 发布新版本

安装包由 GitHub Actions 打包并挂到 Release 上，本地不需要上传文件。

1. 改版本号：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处改成同一个版本，运行一次 `cargo check --manifest-path src-tauri/Cargo.toml` 同步 `Cargo.lock`。
2. 在 `CHANGELOG.md` 顶部写 `## 版本号 — 日期` 和改动，提交并推送到 `main`。
3. 打标签并推送：

   ```bash
   git tag v0.1.7
   git push origin v0.1.7
   ```

推送标签后，**Release** 工作流会：

- 检查标签和 `package.json` 版本是否一致；
- 没有同名 Release 时新建草稿，说明取自 `CHANGELOG.md` 里该版本的内容；已有同名草稿时沿用它的标题和说明；
- 在 macOS（Apple Silicon）和 Windows 上分别跑测试、打包，把 `.dmg` 和 `-setup.exe` 挂到 Release 上；
- 生成 `SHA256SUMS.txt`，全部就绪后公开发布。

任何一步失败，Release 都停在草稿状态，不会公开。修好后可以在 Actions 页面手动运行 **Release**，填入同一个标签重跑。
