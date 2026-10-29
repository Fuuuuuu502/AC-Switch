//! Windows-specific launching, process inspection and current-user DPAPI storage.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

static HOOK_ENABLED: AtomicBool = AtomicBool::new(false);

fn powershell(script: &str) -> Command {
    let mut cmd = command("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    cmd.arg(format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); {script}"));
    cmd
}

fn output(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("Windows 操作失败：{e}"))?;
    if !out.status.success() {
        // Do not propagate PowerShell diagnostics that could include credential input.
        return Err("Windows 操作失败，请检查 Accio 安装位置与当前用户权限。".into());
    }
    String::from_utf8(out.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}

fn join_components(mut path: PathBuf, components: &[&str]) -> PathBuf {
    for component in components {
        path.push(component);
    }
    path
}

pub(super) fn accio_exe() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("AC_SWITCH_ACCIO_PATH") {
        let path = PathBuf::from(path);
        if path.is_file()
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Accio.exe"))
        {
            return Ok(path);
        }
        return Err("AC_SWITCH_ACCIO_PATH 必须指向已安装的 Accio.exe。".into());
    }
    for (base, components) in [
        ("LOCALAPPDATA", &["Programs", "Accio", "Accio.exe"][..]),
        ("LOCALAPPDATA", &["Accio", "Accio.exe"][..]),
        ("ProgramFiles", &["Accio", "Accio.exe"][..]),
        ("ProgramFiles(x86)", &["Accio", "Accio.exe"][..]),
    ] {
        if let Some(base) = std::env::var_os(base) {
            let path = join_components(PathBuf::from(base), components);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    let value = output(powershell(
        r#"
$roots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
foreach($root in $roots) {
  foreach($item in @(Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Accio' })) {
    if($item.InstallLocation) {
      $candidate=Join-Path $item.InstallLocation 'Accio.exe'
      if(Test-Path -LiteralPath $candidate -PathType Leaf) { [Console]::Write($candidate); exit 0 }
    }
  }
}
"#,
    ))?;
    if !value.is_empty() && Path::new(&value).is_file() {
        return Ok(PathBuf::from(value));
    }
    Err("未找到 Windows Accio。请先安装；自定义安装位置可通过 AC_SWITCH_ACCIO_PATH 指定 Accio.exe。".into())
}

fn accio_command(script: &str) -> Result<Command, String> {
    let mut cmd = powershell(&format!(
        r#"$accioProcesses=@(Get-CimInstance Win32_Process -Filter "Name='Accio.exe'" | Where-Object {{ $_.ExecutablePath -eq $env:AC_SWITCH_EXE }}); {script}"#
    ));
    cmd.env("AC_SWITCH_EXE", accio_exe()?);
    Ok(cmd)
}

pub(super) fn accio_running() -> bool {
    accio_process_status().0
}

pub(super) fn quit_accio() -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    output(accio_command(r#"
foreach($p in $accioProcesses) {
  $process=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
}
$deadline=[DateTime]::UtcNow.AddSeconds(8)
do {
  $remaining=@(Get-CimInstance Win32_Process -Filter "Name='Accio.exe'" | Where-Object { $_.ExecutablePath -eq $env:AC_SWITCH_EXE })
  if($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 200
} while([DateTime]::UtcNow -lt $deadline)
foreach($p in $remaining) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
$forceDeadline=[DateTime]::UtcNow.AddSeconds(3)
do {
  $remaining=@(Get-CimInstance Win32_Process -Filter "Name='Accio.exe'" | Where-Object { $_.ExecutablePath -eq $env:AC_SWITCH_EXE })
  if($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 100
} while([DateTime]::UtcNow -lt $forceDeadline)
exit 1
"#)?).map(|_| ()).map_err(|_| "Accio 未能正常退出，请保存任务并手动退出 Accio 后重试。".into())
}

pub(super) fn open_accio() -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    let exe = accio_exe()?;
    let mut cmd = command(&exe);
    if HOOK_ENABLED.load(Ordering::SeqCst) {
        cmd.env("GATEWAY_BASE_URL", relay_url())
            .env("FAST_BUILD", "true");
    } else {
        cmd.env_remove("GATEWAY_BASE_URL").env_remove("FAST_BUILD");
    }
    cmd.current_dir(exe.parent().ok_or("无效的 Accio 路径")?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 Accio 失败：{e}"))?;
    Ok(())
}

pub(super) fn install_hook(state: &AppState) -> Result<(), String> {
    HOOK_ENABLED.store(true, Ordering::SeqCst);
    *state.hook_installed.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}
pub(super) fn launchctl_unset(_key: &str) {
    HOOK_ENABLED.store(false, Ordering::SeqCst);
}

pub(super) fn accio_using_relay() -> bool {
    accio_process_status().1
}

pub(super) fn accio_process_status() -> (bool, bool) {
    if isolated() {
        return (false, false);
    }
    let script = format!(
        r#"if($accioProcesses.Count -eq 0) {{ [Console]::Write('False|False'); exit 0 }}; $usingRelay=$false; try {{ $ids=@($accioProcesses | ForEach-Object {{ $_.ProcessId }}); $connections=@(Get-NetTCPConnection -State Established -RemotePort {} -ErrorAction Stop | Where-Object {{ $_.RemoteAddress -eq '127.0.0.1' -and $_.OwningProcess -in $ids }}); $usingRelay=$connections.Count -gt 0 }} catch {{ }}; [Console]::Write('True|' + $usingRelay.ToString())"#,
        relay_port()
    );
    accio_command(&script)
        .and_then(output)
        .ok()
        .and_then(|value| {
            let mut parts = value.split('|');
            let running = parts.next()? == "True";
            // 新版 Accio 请求结束即断开连接，最近收到过请求也算已接入
            let connected = parts.next()? == "True" || (running && super::relay_recently_used());
            Some((running, connected))
        })
        .unwrap_or((false, false))
}

pub(super) fn clear_owned_orphans(port: u16, _node: &Path, _script: &Path) -> Result<(), String> {
    // First Windows release never kills unknown/orphan listeners. Owned children
    // are tracked by Child handles and stopped separately.
    std::net::TcpListener::bind(("127.0.0.1", port))
        .map(|_| ()).map_err(|_| format!("端口 {port} 已被占用，请退出旧版 AC-Switch 或相关服务后重试；未终止任何其他进程。"))
}

pub(super) fn file_set(account: &str, secret: &str) -> Result<(), String> {
    let path = key_file(account)?;
    let mut cmd = powershell(
        r#"
Add-Type -AssemblyName System.Security
$plain=[Console]::In.ReadToEnd()
$bytes=[Text.Encoding]::UTF8.GetBytes($plain)
$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($env:AC_SWITCH_KEY_FILE,$encrypted)
"#,
    );
    cmd.env("AC_SWITCH_KEY_FILE", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let written = child
        .stdin
        .take()
        .ok_or("无法写入凭据加密进程")?
        .write_all(secret.as_bytes());
    if let Err(e) = written {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e.to_string());
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err("Windows DPAPI 凭据加密失败".into());
    }
    Ok(())
}

pub(super) fn file_get(account: &str) -> Result<Option<String>, String> {
    let path = key_file(account)?;
    if !path.exists() {
        return Ok(None);
    }
    let mut cmd = powershell(
        r#"
Add-Type -AssemblyName System.Security
$encrypted=[IO.File]::ReadAllBytes($env:AC_SWITCH_KEY_FILE)
$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Write([Text.Encoding]::UTF8.GetString($plain))
"#,
    );
    cmd.env("AC_SWITCH_KEY_FILE", path);
    let value = output(cmd)
        .map_err(|_| "无法解密 Windows 凭据，请使用原 Windows 用户或重新填写 Key。".to_string())?;
    Ok(if value.is_empty() { None } else { Some(value) })
}

pub(super) fn keychain_set(_account: &str, _secret: &str) -> Result<(), String> {
    Ok(())
}
pub(super) fn keychain_get(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}
pub(super) fn keychain_delete(_account: &str) {}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn accio_candidate_uses_native_windows_separators() {
        let path = join_components(
            PathBuf::from(r"C:\Users\Example\AppData\Local"),
            &["Programs", "Accio", "Accio.exe"],
        );
        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\Example\AppData\Local\Programs\Accio\Accio.exe")
        );
        assert!(!path.to_string_lossy().contains('/'));
    }

    #[test]
    fn dpapi_roundtrip_and_ciphertext() {
        // CI runs with one test thread because this test isolates config via env.
        let dir = std::env::temp_dir().join(format!("accio-dpapi-{}", Uuid::new_v4()));
        let previous = std::env::var_os("AC_SWITCH_TEST_DIR");
        std::env::set_var("AC_SWITCH_TEST_DIR", &dir);
        let result = (|| -> Result<(), String> {
            file_set("test-key", "mock-windows-key")?;
            assert_eq!(file_get("test-key")?, Some("mock-windows-key".into()));
            let bytes = fs::read(dir.join("keys/test-key")).unwrap();
            assert!(!bytes
                .windows(b"mock-windows-key".len())
                .any(|part| part == b"mock-windows-key"));
            Ok(())
        })();
        if let Some(value) = previous {
            std::env::set_var("AC_SWITCH_TEST_DIR", value);
        } else {
            std::env::remove_var("AC_SWITCH_TEST_DIR");
        }
        let _ = fs::remove_dir_all(dir);
        result.unwrap();
    }
}
