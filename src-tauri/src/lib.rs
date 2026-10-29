use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, State,
};
use uuid::Uuid;
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod windows;
#[cfg(target_os = "windows")]
use windows::{
    accio_process_status, accio_running, accio_using_relay, clear_owned_orphans, file_get,
    file_set, install_hook, keychain_delete, keychain_get, keychain_set, launchctl_unset,
    open_accio, quit_accio,
};

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW for background helpers.
    }
    cmd
}

#[cfg(target_os = "windows")]
fn node_compatible_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.starts_with(VERBATIM_UNC) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&wide[VERBATIM_UNC.len()..]);
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if wide.starts_with(VERBATIM) {
        return PathBuf::from(OsString::from_wide(&wide[VERBATIM.len()..]));
    }
    path.to_path_buf()
}

#[cfg(not(target_os = "windows"))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn isolated() -> bool {
    std::env::var_os("AC_SWITCH_TEST_DIR").is_some()
}
fn relay_port() -> u16 {
    test_port("AC_SWITCH_TEST_RELAY_PORT", 18767)
}
fn bridge_port() -> u16 {
    test_port("AC_SWITCH_TEST_BRIDGE_PORT", 18765)
}
fn test_port(name: &str, default: u16) -> u16 {
    if isolated() {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|p| *p > 0)
            .expect("isolated tests require explicit ports")
    } else {
        default
    }
}
fn relay_url() -> String {
    format!("http://127.0.0.1:{}", relay_port())
}
fn bridge_url() -> String {
    format!("http://127.0.0.1:{}", bridge_port())
}
#[cfg(not(target_os = "windows"))]
const ACCIO_APP: &str = "/Applications/Accio.app";
#[cfg(not(target_os = "windows"))]
const KEYCHAIN_SERVICE: &str = "ac-switch";
// 0.1.5 及以前名为 Accio Switch，钥匙串里的旧条目仍可读取
#[cfg(not(target_os = "windows"))]
const LEGACY_KEYCHAIN_SERVICE: &str = "accio-switch";
const IMAGE_ACCOUNT: &str = "image-channel";

fn default_protocol() -> String {
    "chat_completions".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub reasoning_effort: String,
    #[serde(default = "default_protocol")]
    pub api_protocol: String,
    #[serde(default)]
    pub image_endpoint: String,
    #[serde(default)]
    pub image_model: String,
    pub has_key: bool,
}

fn default_image_channel() -> ImageChannel {
    ImageChannel {
        enabled: false,
        endpoint: String::new(),
        model: String::new(),
        has_key: false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageChannel {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub active_provider_id: String,
    pub providers: Vec<Provider>,
    #[serde(default = "default_image_channel")]
    pub image_channel: ImageChannel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    initializing: bool,
    pub runtime_error: String,
    pub accio_running: bool,
    pub relay_ok: bool,
    pub bridge_ok: bool,
    pub active_provider_id: String,
    pub hook: String,
    pub bridge_auth_type: String,
    pub bridge_api_key_configured: bool,
    pub accio_restarted: bool,
    pub accio_using_relay: bool,
}

struct RuntimeState {
    relay: Option<Child>,
    bridge: Option<Child>,
}

struct AppState {
    operation: Mutex<()>,
    initializing: AtomicBool,
    runtime: Mutex<RuntimeState>,
    tray: Mutex<Option<TrayIcon>>,
    error: Mutex<String>,
    hook_installed: Mutex<bool>,
}

fn config_dir() -> Result<PathBuf, String> {
    let dir = if let Some(dir) = std::env::var_os("AC_SWITCH_TEST_DIR") {
        PathBuf::from(dir)
    } else {
        let home = dirs::home_dir().ok_or_else(|| "home directory not found".to_string())?;
        let dir = home.join(".ac-switch");
        // 0.1.5 及以前的配置目录是 ~/.accio-switch，首次启动时整体搬过来
        let legacy = home.join(".accio-switch");
        if !dir.exists() && legacy.is_dir() {
            let _ = fs::rename(&legacy, &dir);
        }
        dir
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

fn default_config() -> AppConfig {
    AppConfig {
        active_provider_id: "official".to_string(),
        providers: vec![Provider {
            id: "opencode-go".to_string(),
            kind: "opencode_go".to_string(),
            name: "OpenCode Go".to_string(),
            endpoint: "https://opencode.ai/zen/go/v1/chat/completions".to_string(),
            model: "deepseek-v4-flash".to_string(),
            reasoning_effort: "high".to_string(),
            api_protocol: default_protocol(),
            image_endpoint: String::new(),
            image_model: String::new(),
            has_key: false,
        }],
        image_channel: default_image_channel(),
    }
}

// 内置供应商：始终排在列表最前，不能删除，名称和接口地址不可改
const NOVAFERRY_ID: &str = "novaferry";
const NOVAFERRY_ENDPOINT: &str = "https://api.novaferry.com/v1/chat/completions";

fn novaferry_provider() -> Provider {
    Provider {
        id: NOVAFERRY_ID.to_string(),
        kind: "custom_openai".to_string(),
        name: "Novaferry".to_string(),
        endpoint: NOVAFERRY_ENDPOINT.to_string(),
        model: "gpt-6.1-sol".to_string(),
        reasoning_effort: "high".to_string(),
        api_protocol: default_protocol(),
        image_endpoint: String::new(),
        image_model: String::new(),
        has_key: false,
    }
}

fn with_fixed_providers(mut cfg: AppConfig) -> AppConfig {
    if !cfg.providers.iter().any(|p| p.id == NOVAFERRY_ID) {
        cfg.providers.insert(0, novaferry_provider());
    }
    cfg
}

fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let cfg = default_config();
        save_config(&cfg)?;
        return Ok(with_fixed_providers(cfg));
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw)
        .map(with_fixed_providers)
        .map_err(|e| e.to_string())
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path()?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn switch_log(msg: &str) {
    if let Ok(dir) = config_dir() {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("switch.log"))
        {
            let _ = writeln!(file, "{msg}");
        }
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn keys_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join("keys");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    set_mode(&dir, 0o700);
    Ok(dir)
}

fn key_file(account: &str) -> Result<PathBuf, String> {
    if account.is_empty()
        || !account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("无效的凭据标识".into());
    }
    Ok(keys_dir()?.join(account))
}

#[cfg(not(target_os = "windows"))]
fn file_set(account: &str, secret: &str) -> Result<(), String> {
    let path = key_file(account)?;
    fs::write(&path, secret.as_bytes()).map_err(|e| e.to_string())?;
    set_mode(&path, 0o600);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn file_get(account: &str) -> Result<Option<String>, String> {
    let path = key_file(account)?;
    if !path.exists() {
        return Ok(None);
    }
    let value = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

fn file_delete(account: &str) {
    if let Ok(path) = key_file(account) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(not(target_os = "windows"))]
fn keychain_set(account: &str, secret: &str) -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    let status = command("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            account,
            "-w",
            secret,
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("failed to save key to Keychain".into())
    }
}

#[cfg(not(target_os = "windows"))]
fn keychain_get(account: &str) -> Result<Option<String>, String> {
    if isolated() {
        return Ok(None);
    }
    for service in [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE] {
        let output = command("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let compact = err.trim().replace('\n', " ");
            if !compact.is_empty() {
                switch_log(&format!("keychain_get {service}/{account} failed: {compact}"));
            }
            continue;
        }
        let value = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn keychain_delete(account: &str) {
    if isolated() {
        return;
    }
    for service in [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE] {
        let _ = command("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .status();
    }
}

fn opencode_auth_key() -> Option<String> {
    if isolated() {
        return None;
    }
    let home = dirs::home_dir()?;
    for rel in [
        ".local/share/opencode/auth.json",
        ".config/opencode/auth.json",
    ] {
        let path = home.join(rel);
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(key) = value
            .get("opencode-go")
            .and_then(|item| item.get("key"))
            .and_then(|item| item.as_str())
        {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn secret_set(account: &str, secret: &str) -> Result<(), String> {
    file_set(account, secret)?;
    if let Err(err) = keychain_set(account, secret) {
        switch_log(&format!("keychain_set {account} failed: {err}"));
    }
    Ok(())
}

fn secret_get(account: &str, kind: &str) -> Result<Option<String>, String> {
    if let Some(value) = file_get(account)? {
        return Ok(Some(value));
    }
    if let Some(value) = keychain_get(account)? {
        let _ = file_set(account, &value);
        return Ok(Some(value));
    }
    if kind == "opencode_go" {
        if let Some(value) = opencode_auth_key() {
            let _ = file_set(account, &value);
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn secret_delete(account: &str) {
    if key_file(account).is_err() {
        return;
    }
    keychain_delete(account);
    file_delete(account);
}

fn with_has_key(mut provider: Provider) -> Provider {
    provider.has_key = secret_get(&provider.id, &provider.kind)
        .ok()
        .flatten()
        .is_some();
    provider
}

fn with_image_has_key(mut channel: ImageChannel) -> ImageChannel {
    channel.has_key = secret_get(IMAGE_ACCOUNT, "image").ok().flatten().is_some();
    channel
}

fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
        if dir.ends_with("src-tauri") {
            dir.pop();
        }
        return Ok(dir.join("sidecar"));
    }
    app.path()
        .resource_dir()
        .map(|p| p.join("sidecar"))
        .map_err(|e| e.to_string())
}

fn node_bin(app: &AppHandle) -> Result<PathBuf, String> {
    if !cfg!(debug_assertions) {
        let path = app.path().resource_dir().map_err(|e| e.to_string())?.join(
            if cfg!(target_os = "windows") {
                "runtime/node.exe"
            } else {
                "runtime/node"
            },
        );
        if !path.is_file() {
            return Err(format!("内置 Node 缺失，请重新安装：{}", path.display()));
        }
        return Ok(path);
    }
    Ok([
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
    .unwrap_or_else(|| PathBuf::from("node")))
}

fn local_http_body(url: &str) -> Option<Vec<u8>> {
    let target = url.strip_prefix("http://127.0.0.1:")?;
    let (port, path) = target.split_once('/')?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port.parse::<u16>().ok()?));
    let timeout = Duration::from_secs(1);
    let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    stream
        .write_all(
            format!("GET /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .ok()?;
    stream.flush().ok()?;

    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status).ok()?;
    if !status.starts_with("HTTP/1.1 200 ") && !status.starts_with("HTTP/1.0 200 ") {
        return None;
    }

    let mut content_length = None;
    let mut chunked = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
            }
        }
    }

    if let Some(size) = content_length {
        if size > 256 * 1024 {
            return None;
        }
        let mut body = vec![0_u8; size];
        reader.read_exact(&mut body).ok()?;
        return Some(body);
    }
    if chunked {
        let mut body = Vec::new();
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).ok()?;
            let size = usize::from_str_radix(size_line.trim().split(';').next()?, 16).ok()?;
            if size == 0 {
                return Some(body);
            }
            if body.len().checked_add(size)? > 256 * 1024 {
                return None;
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..]).ok()?;
            let mut ending = [0_u8; 2];
            reader.read_exact(&mut ending).ok()?;
            if ending != *b"\r\n" {
                return None;
            }
        }
    }

    let mut body = Vec::new();
    reader.take(256 * 1024).read_to_end(&mut body).ok()?;
    Some(body)
}

fn http_ok(url: &str) -> bool {
    local_http_body(url).is_some()
}

#[cfg(not(target_os = "windows"))]
fn accio_running() -> bool {
    if isolated() {
        return false;
    }
    command("pgrep")
        .args(["-x", "Accio"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn accio_process_status() -> (bool, bool) {
    (accio_running(), accio_using_relay())
}

#[cfg(not(target_os = "windows"))]
fn quit_accio() -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    let _ = command("osascript")
        .args(["-e", "quit app \"Accio\""])
        .status();
    std::thread::sleep(Duration::from_millis(1200));
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn launchctl_set(key: &str, value: &str) -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    command("launchctl")
        .args(["setenv", key, value])
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("launchctl setenv {key} failed"))
            }
        })
}

#[cfg(not(target_os = "windows"))]
fn install_hook(state: &AppState) -> Result<(), String> {
    let previous = if isolated() {
        None
    } else {
        command("launchctl")
            .args(["getenv", "GATEWAY_BASE_URL"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    launchctl_set("GATEWAY_BASE_URL", &relay_url())?;
    if let Err(error) = launchctl_set("FAST_BUILD", "true") {
        if let Some(value) = previous {
            launchctl_set("GATEWAY_BASE_URL", &value)?;
        } else {
            launchctl_unset("GATEWAY_BASE_URL");
        }
        return Err(error);
    }
    *state.hook_installed.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn launchctl_unset(key: &str) {
    if isolated() {
        return;
    }
    let _ = command("launchctl").args(["unsetenv", key]).status();
}

#[cfg(not(target_os = "windows"))]
fn open_accio() -> Result<(), String> {
    if isolated() {
        return Ok(());
    }
    if !Path::new(ACCIO_APP).exists() {
        return Err("未找到 /Applications/Accio.app".into());
    }
    command("open")
        .arg(ACCIO_APP)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("failed to open Accio".into())
            }
        })
}

fn spawn_node(
    node: &Path,
    script: &Path,
    extra_env: &[(&str, String)],
    log_path: &Path,
) -> Result<Child, String> {
    // Tauri returns verbatim resource paths (\\?\C:\...) on Windows. Node 24
    // interprets such a main-module argument as the drive root and exits with
    // EISDIR, so pass ordinary drive/UNC paths to the embedded runtime.
    let node = node_compatible_path(node);
    let script = node_compatible_path(script);
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = command(&node);
    cmd.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    cmd.arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err));
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to start {}: {e}", script.display()))
}

#[cfg(not(target_os = "windows"))]
fn listen_pids(port: u16) -> Vec<String> {
    let output = command("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .map(str::to_string)
            .filter(|pid| !pid.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

// Never kill a process merely because it owns one of our ports.
#[cfg(not(target_os = "windows"))]
fn clear_owned_orphans(port: u16, node: &Path, script: &Path) -> Result<(), String> {
    for pid in listen_pids(port) {
        let out = command("ps")
            .args(["-p", &pid, "-o", "ppid=,command="])
            .output()
            .map_err(|e| e.to_string())?;
        let process_command = String::from_utf8_lossy(&out.stdout);
        let expected = format!("{} {}", node.display(), script.display());
        let owned = process_command
            .trim()
            .strip_prefix('1')
            .is_some_and(|rest| rest.starts_with(char::is_whitespace) && rest.trim() == expected);
        if !owned {
            return Err(format!(
                "端口 {port} 被其他进程（PID {pid}）占用，请先关闭该服务。"
            ));
        }
        command("kill")
            .args(["-TERM", &pid])
            .status()
            .map_err(|e| e.to_string())?;
    }
    for _ in 0..20 {
        if listen_pids(port).is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("端口 {port} 尚未释放，请退出旧中继后重试。"))
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(proc) = child.as_mut() {
        let _ = proc.kill();
        let _ = proc.wait();
    }
    *child = None;
}

fn wait_health(url: &str) -> Result<(), String> {
    for _ in 0..40 {
        if http_ok(url) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!("timed out waiting for {url}"))
}

// Accio 0.36 起每个请求结束就断开连接，只看已建立的连接会时有时无。
// 先看 Accio 进程启动时带的网关变量，再看连接，最后看中继最近是否收到过请求。
#[cfg(not(target_os = "windows"))]
fn accio_using_relay() -> bool {
    if isolated() {
        return false;
    }
    if accio_launched_with_relay() {
        return true;
    }
    let output = command("lsof")
        .args(["-nP", "-iTCP:18767", "-sTCP:ESTABLISHED"])
        .output();
    let connected = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .any(|line| line.contains("Accio")),
        Err(_) => false,
    };
    connected || (accio_running() && relay_recently_used())
}

#[cfg(not(target_os = "windows"))]
fn accio_launched_with_relay() -> bool {
    let expected = format!("GATEWAY_BASE_URL={}", relay_url());
    let Ok(out) = command("pgrep").args(["-x", "Accio"]).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .any(|pid| {
            command("ps")
                .args(["eww", "-o", "command=", "-p", pid])
                .output()
                .map(|ps| {
                    String::from_utf8_lossy(&ps.stdout)
                        .split_whitespace()
                        .any(|token| token == expected)
                })
                .unwrap_or(false)
        })
}

const RELAY_RECENT_MS: u64 = 120_000;

fn relay_recently_used() -> bool {
    let Some(last) = curl_json(&format!("{}/healthz", relay_url()))
        .and_then(|status| status.get("lastClientRequestAt").and_then(|value| value.as_u64()))
    else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    last > 0 && now.saturating_sub(last) <= RELAY_RECENT_MS
}

fn detect_accio_paths() -> (String, String) {
    let default_model = vec![
        "/api/adk/llm/generateContent".to_string(),
        "/api/adk/llm/streamGenerateContent".to_string(),
    ];
    let default_image = vec![
        "/api/image/generate".to_string(),
        "/api/image/edit".to_string(),
        "/api/media/image/generate".to_string(),
        "/api/media/image/edit".to_string(),
    ];
    if isolated() {
        return (default_model.join(","), default_image.join(","));
    }
    #[cfg(not(target_os = "windows"))]
    let asar = PathBuf::from("/Applications/Accio.app/Contents/Resources/app.asar");
    #[cfg(target_os = "windows")]
    let asar = match windows::accio_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("resources/app.asar")))
    {
        Some(path) => path,
        None => return (default_model.join(","), default_image.join(",")),
    };
    let asar_len = fs::metadata(&asar).map(|meta| meta.len()).unwrap_or(0);
    if let Ok(dir) = config_dir() {
        let cache_path = dir.join("detected-paths.json");
        if let Ok(raw) = fs::read_to_string(&cache_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if value.get("asarBytes").and_then(|item| item.as_u64()) == Some(asar_len) {
                    if let (Some(model), Some(image)) = (
                        value.get("modelPaths").and_then(|item| item.as_array()),
                        value.get("imagePaths").and_then(|item| item.as_array()),
                    ) {
                        let model = model
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .collect::<Vec<_>>();
                        let image = image
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .collect::<Vec<_>>();
                        if !model.is_empty() {
                            return (model.join(","), image.join(","));
                        }
                    }
                }
            }
        }
    }
    let mut model = default_model;
    let mut image = default_image;
    if let Ok(data) = fs::read(&asar) {
        let text = String::from_utf8_lossy(&data);
        for extra in [
            "/api/adk/llm/generate",
            "/api/llm/generateContent",
            "/api/adk/llm/streamGenerateContentProto",
        ] {
            if text.contains(extra) && !model.iter().any(|item| item == extra) {
                model.push(extra.to_string());
            }
        }
        image.retain(|path| text.contains(path.as_str()));
        if image.is_empty() {
            image = vec![
                "/api/image/generate".to_string(),
                "/api/media/image/generate".to_string(),
            ];
        }
        if let Ok(dir) = config_dir() {
            let payload = serde_json::json!({
                "asarBytes": data.len(),
                "modelPaths": model,
                "imagePaths": image,
                "hasGatewayBaseUrl": text.contains("GATEWAY_BASE_URL"),
            });
            let _ = fs::write(dir.join("detected-paths.json"), payload.to_string());
        }
        switch_log(&format!(
            "detect_accio_paths model={} image={}",
            model.join(","),
            image.join(",")
        ));
    }
    (model.join(","), image.join(","))
}

fn maybe_open_or_restart_accio() -> Result<bool, String> {
    if !accio_running() {
        open_accio()?;
        return Ok(true);
    }
    if accio_using_relay() {
        return Ok(false);
    }
    quit_accio()?;
    open_accio()?;
    Ok(true)
}

fn start_backend(app: &AppHandle, state: &AppState, provider: &Provider) -> Result<(), String> {
    let result = start_backend_inner(app, state, provider);
    *state.error.lock().map_err(|e| e.to_string())? =
        result.as_ref().err().cloned().unwrap_or_default();
    result
}

fn start_backend_inner(
    app: &AppHandle,
    state: &AppState,
    provider: &Provider,
) -> Result<(), String> {
    let node = node_bin(app)?;
    let sidecar = sidecar_dir(app)?;
    let relay_script = sidecar.join("gateway-relay.cjs");
    let bridge_script = sidecar.join("openai-bridge.cjs");
    if !relay_script.exists() || !bridge_script.exists() {
        return Err(format!("sidecar missing in {}", sidecar.display()));
    }
    let official = provider.kind == "official" || provider.id == "official";
    let key = if official {
        String::new()
    } else {
        secret_get(&provider.id, &provider.kind)?.unwrap_or_default()
    };
    if provider.kind == "opencode_go" && key.is_empty() {
        return Err("OpenCode Go 需要 API Key。请先在供应商里填写 sk- 开头的 Key，或确认 ~/.local/share/opencode/auth.json 已有 opencode-go.key".into());
    }
    let log_dir = config_dir()?;
    let api_provider = if provider.kind == "custom_openai" {
        "custom_openai"
    } else {
        "opencode_go"
    };
    let auth_type = if key.is_empty() { "none" } else { "api_key" };
    let protocol = if provider.api_protocol.trim().is_empty() {
        default_protocol()
    } else {
        provider.api_protocol.clone()
    };
    let (model_paths, image_paths) = detect_accio_paths();
    let image = with_image_has_key(load_config()?.image_channel);
    let image_enabled = !official && image.enabled && !image.model.trim().is_empty();
    let image_key = if image_enabled {
        secret_get(IMAGE_ACCOUNT, "image")?.unwrap_or_default()
    } else {
        String::new()
    };
    switch_log(&format!(
        "start_backend provider={} kind={} auth_type={} protocol={} key_len={} official={} image_enabled={} image_model={}",
        provider.id,
        provider.kind,
        auth_type,
        protocol,
        key.len(),
        official,
        image_enabled,
        image.model
    ));

    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    stop_child(&mut runtime.relay);
    stop_child(&mut runtime.bridge);
    if !official {
        clear_owned_orphans(bridge_port(), &node, &bridge_script)?;
    }
    clear_owned_orphans(relay_port(), &node, &relay_script)?;

    let result = (|| -> Result<(), String> {
        if !official {
            let bridge_env = vec![
                ("ACCIO_OPENCODE_PORT", bridge_port().to_string()),
                ("OPENCODE_GO_MODEL", provider.model.clone()),
                ("OPENCODE_GO_ENDPOINT", provider.endpoint.clone()),
                (
                    "OPENCODE_GO_REASONING_EFFORT",
                    provider.reasoning_effort.clone(),
                ),
                ("ACCIO_MODEL_AUTH_TYPE", auth_type.to_string()),
                ("ACCIO_API_PROVIDER", api_provider.to_string()),
                ("ACCIO_API_PROTOCOL", protocol),
                ("ACCIO_MODEL_PATHS", model_paths.clone()),
                ("OPENCODE_GO_API_KEY", key),
                (
                    "ACCIO_IMAGE_ENABLED",
                    if image_enabled {
                        "true".into()
                    } else {
                        "false".into()
                    },
                ),
                ("OPENCODE_GO_IMAGE_ENDPOINT", image.endpoint.clone()),
                ("OPENCODE_GO_IMAGE_MODEL", image.model.clone()),
                ("OPENCODE_GO_IMAGE_API_KEY", image_key),
            ];
            runtime.bridge = Some(spawn_node(
                &node,
                &bridge_script,
                &bridge_env,
                &log_dir.join("bridge.log"),
            )?);
        }

        let relay_env = vec![
            ("ACCIO_RELAY_PORT", relay_port().to_string()),
            ("ACCIO_MODEL_BRIDGE_URL", bridge_url()),
            (
                "ACCIO_ROUTE_MODE",
                if official {
                    "official".into()
                } else {
                    "custom".into()
                },
            ),
            ("ACCIO_MODEL_PATHS", model_paths),
            ("ACCIO_IMAGE_PATHS", image_paths),
            (
                "ACCIO_RELAY_LOG",
                log_dir.join("relay.log").to_string_lossy().to_string(),
            ),
        ];
        runtime.relay = Some(spawn_node(
            &node,
            &relay_script,
            &relay_env,
            &log_dir.join("relay-stdout.log"),
        )?);
        std::thread::sleep(Duration::from_millis(150));
        if !official {
            ensure_running(&mut runtime.bridge, "model bridge")?;
        }
        ensure_running(&mut runtime.relay, "gateway relay")?;

        if !official {
            wait_health(&format!("{}/healthz", bridge_url()))?;
        }
        wait_health(&format!("{}/healthz", relay_url()))?;
        if provider.kind == "opencode_go" {
            let health = curl_json(&format!("{}/healthz", bridge_url()));
            let configured = health
                .as_ref()
                .and_then(|value| value.get("apiKeyConfigured"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if !configured {
                return Err("模型桥已启动，但没有带上 API Key。请重新保存 Key 后再启用。".into());
            }
        }
        Ok(())
    })();
    if result.is_err() {
        stop_child(&mut runtime.relay);
        stop_child(&mut runtime.bridge);
    }
    result
}

fn ensure_running(child: &mut Option<Child>, name: &str) -> Result<(), String> {
    match child {
        Some(proc) => match proc.try_wait() {
            Ok(None) => Ok(()),
            Ok(Some(status)) => {
                let log = config_dir()?.join(if name == "gateway relay" {
                    "relay-stdout.log"
                } else {
                    "bridge.log"
                });
                Err(format!(
                    "{name} 立刻退出（{status}）。查看 {}",
                    log.display()
                ))
            }
            Err(err) => Err(format!("{name} wait failed: {err}")),
        },
        None => Err(format!("{name} was not started")),
    }
}

fn stop_backend(state: &AppState) -> Result<(), String> {
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    stop_child(&mut runtime.relay);
    stop_child(&mut runtime.bridge);
    Ok(())
}

#[tauri::command(async)]
fn get_config() -> Result<AppConfig, String> {
    let mut cfg = load_config()?;
    for provider in &mut cfg.providers {
        *provider = with_has_key(provider.clone());
    }
    cfg.image_channel = with_image_has_key(cfg.image_channel);
    Ok(cfg)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProviderInput {
    id: Option<String>,
    kind: String,
    name: String,
    endpoint: String,
    model: String,
    reasoning_effort: String,
    api_protocol: Option<String>,
    image_endpoint: Option<String>,
    image_model: Option<String>,
    api_key: Option<String>,
}

#[tauri::command(async)]
fn upsert_provider(
    app: AppHandle,
    state: State<AppState>,
    input: UpsertProviderInput,
) -> Result<AppConfig, String> {
    let config = {
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        if input.kind != "opencode_go" && input.kind != "custom_openai" {
            return Err("unsupported provider kind".into());
        }
        let mut cfg = load_config()?;
        let id = input
            .id
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        key_file(&id)?;
        if id == "official" || id == IMAGE_ACCOUNT {
            return Err("不能使用保留的供应商标识".into());
        }
        let fixed = id == NOVAFERRY_ID;
        if fixed && !input.endpoint.starts_with("https://api.novaferry.com/") {
            return Err("Novaferry 是内置供应商，接口地址不能修改".into());
        }
        if let Some(key) = input.api_key {
            let trimmed = key.trim().to_string();
            if trimmed.is_empty() {
                secret_delete(&id);
            } else {
                secret_set(&id, &trimmed)?;
            }
        }
        let provider = with_has_key(Provider {
            id: id.clone(),
            kind: if fixed { "custom_openai".into() } else { input.kind },
            name: if fixed { "Novaferry".into() } else { input.name },
            endpoint: input.endpoint,
            model: input.model,
            reasoning_effort: input.reasoning_effort,
            api_protocol: input
                .api_protocol
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_protocol),
            image_endpoint: input.image_endpoint.unwrap_or_default(),
            image_model: input.image_model.unwrap_or_default(),
            has_key: false,
        });
        if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == id) {
            *existing = provider.clone();
        } else {
            cfg.providers.push(provider.clone());
        }
        save_config(&cfg)?;
        if cfg.active_provider_id == id {
            start_backend(&app, &state, &provider)?;
        }
        get_config()?
    };
    // Menu updates may marshal onto the UI thread. Never wait for one while
    // holding the operation mutex, because Exit also serializes on that mutex.
    rebuild_tray_menu(&app)?;
    Ok(config)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertImageInput {
    enabled: bool,
    endpoint: String,
    model: String,
    api_key: Option<String>,
}

fn restart_active_backend(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let cfg = load_config()?;
    let provider = if cfg.active_provider_id == "official" {
        Provider {
            id: "official".into(),
            kind: "official".into(),
            name: "Accio 官方原生认证".into(),
            endpoint: String::new(),
            model: String::new(),
            reasoning_effort: "-".into(),
            api_protocol: default_protocol(),
            image_endpoint: String::new(),
            image_model: String::new(),
            has_key: false,
        }
    } else {
        cfg.providers
            .iter()
            .find(|item| item.id == cfg.active_provider_id)
            .cloned()
            .ok_or_else(|| "active provider not found".to_string())?
    };
    start_backend(app, state, &provider)
}

#[tauri::command(async)]
fn upsert_image_channel(
    app: AppHandle,
    state: State<AppState>,
    input: UpsertImageInput,
) -> Result<AppConfig, String> {
    let config = {
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        if input.enabled && input.model.trim().is_empty() {
            return Err("启用图片通道时请填写图片模型，例如 gpt-image-1".into());
        }
        if let Some(key) = input.api_key {
            let trimmed = key.trim().to_string();
            if trimmed.is_empty() {
                secret_delete(IMAGE_ACCOUNT);
            } else {
                secret_set(IMAGE_ACCOUNT, &trimmed)?;
            }
        }
        let mut cfg = load_config()?;
        cfg.image_channel.enabled = input.enabled;
        cfg.image_channel.endpoint = input.endpoint.trim().to_string();
        cfg.image_channel.model = input.model.trim().to_string();
        save_config(&cfg)?;
        if cfg.active_provider_id != "official" {
            restart_active_backend(&app, &state)?;
        }
        get_config()?
    };
    Ok(config)
}

#[tauri::command(async)]
fn delete_provider(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<AppConfig, String> {
    let config = {
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        key_file(&id)?;
        if id == "official" || id == IMAGE_ACCOUNT {
            return Err("不能删除保留标识".into());
        }
        if id == NOVAFERRY_ID {
            return Err("Novaferry 是内置供应商，不能删除".into());
        }
        let mut cfg = load_config()?;
        if !cfg.providers.iter().any(|p| p.id == id) {
            return Err("供应商不存在".into());
        }
        let was_active = cfg.active_provider_id == id;
        if was_active {
            apply_provider_inner(app.clone(), state.clone(), "official".into())?;
            cfg.active_provider_id = "official".into();
        }
        cfg.providers.retain(|p| p.id != id);
        secret_delete(&id);
        save_config(&cfg)?;
        get_config()?
    };
    rebuild_tray_menu(&app)?;
    Ok(config)
}

fn curl_json(url: &str) -> Option<serde_json::Value> {
    serde_json::from_slice(&local_http_body(url)?).ok()
}

#[tauri::command(async)]
fn get_status(state: State<AppState>) -> Result<AppStatus, String> {
    let cfg = load_config()?;
    let health = curl_json(&format!("{}/healthz", bridge_url()));
    let (is_accio_running, is_accio_using_relay) = accio_process_status();
    let bridge_auth_type = health
        .as_ref()
        .and_then(|value| value.get("authType"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let bridge_api_key_configured = health
        .as_ref()
        .and_then(|value| value.get("apiKeyConfigured"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    Ok(AppStatus {
        initializing: state.initializing.load(Ordering::SeqCst),
        runtime_error: state.error.lock().map_err(|e| e.to_string())?.clone(),
        accio_running: is_accio_running,
        relay_ok: http_ok(&format!("{}/healthz", relay_url())),
        bridge_ok: health.is_some(),
        active_provider_id: cfg.active_provider_id,
        hook: "gateway_base_url".into(),
        bridge_auth_type,
        bridge_api_key_configured,
        accio_restarted: false,
        accio_using_relay: is_accio_using_relay,
    })
}

#[tauri::command(async)]
fn apply_provider(app: AppHandle, state: State<AppState>, id: String) -> Result<AppStatus, String> {
    let status = {
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        apply_provider_inner(app.clone(), state.clone(), id)?
    };
    rebuild_tray_menu(&app)?;
    Ok(status)
}

fn apply_provider_inner(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<AppStatus, String> {
    let mut cfg = load_config()?;
    let provider = if id == "official" {
        Provider {
            id: "official".into(),
            kind: "official".into(),
            name: "Accio 官方原生认证".into(),
            endpoint: String::new(),
            model: String::new(),
            reasoning_effort: "-".into(),
            api_protocol: default_protocol(),
            image_endpoint: String::new(),
            image_model: String::new(),
            has_key: false,
        }
    } else {
        cfg.providers
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "provider not found".to_string())?
    };
    let was_hooked = accio_using_relay();
    start_backend(&app, &state, &provider)?;
    if let Err(error) = install_hook(state.inner()) {
        let _ = stop_backend(state.inner());
        *state.error.lock().map_err(|e| e.to_string())? = error.clone();
        return Err(error);
    }
    cfg.active_provider_id = id;
    save_config(&cfg)?;
    let accio_restarted = if was_hooked && accio_running() {
        false
    } else {
        maybe_open_or_restart_accio()?
    };
    let mut status = get_status(state)?;
    status.accio_restarted = accio_restarted;
    Ok(status)
}

#[tauri::command(async)]
fn restart_accio(state: State<AppState>) -> Result<AppStatus, String> {
    let _operation = state.operation.lock().map_err(|e| e.to_string())?;
    quit_accio()?;
    open_accio()?;
    get_status(state.clone())
}

fn make_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let cfg = load_config()?;
    let open_item = MenuItem::with_id(app, "open", "打开 AC-Switch", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let restart_item = MenuItem::with_id(app, "restart", "重启 Accio", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "退出托盘", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let official = CheckMenuItem::with_id(
        app,
        "provider:official",
        "Accio 官方原生认证",
        true,
        cfg.active_provider_id == "official",
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let mut provider_items = Vec::new();
    for provider in &cfg.providers {
        provider_items.push(
            CheckMenuItem::with_id(
                app,
                format!("provider:{}", provider.id),
                &provider.name,
                true,
                cfg.active_provider_id == provider.id,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
        );
    }
    let mut refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        vec![&open_item, &sep1, &official];
    for item in &provider_items {
        refs.push(item);
    }
    refs.push(&sep2);
    refs.push(&restart_item);
    refs.push(&quit_item);
    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

fn rebuild_tray_menu(app: &AppHandle) -> Result<(), String> {
    let menu = make_tray_menu(app)?;
    let state = app.state::<AppState>();
    if let Ok(guard) = state.tray.lock() {
        if let Some(tray) = guard.as_ref() {
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let menu = make_tray_menu(app)?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png")).map_err(|e| e.to_string())?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == "open" {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                return;
            }
            if id == "restart" {
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(err) = restart_accio(handle.state::<AppState>()) {
                        *handle.state::<AppState>().error.lock().unwrap() = err;
                    }
                });
                return;
            }
            if id == "quit" {
                app.exit(0);
                return;
            }
            if let Some(provider_id) = id.strip_prefix("provider:") {
                let handle = app.clone();
                let provider_id = provider_id.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(err) =
                        apply_provider(handle.clone(), handle.state::<AppState>(), provider_id)
                    {
                        *handle.state::<AppState>().error.lock().unwrap() = err;
                    }
                });
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    if let Ok(mut slot) = state.tray.lock() {
        *slot = Some(tray);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            operation: Mutex::new(()),
            initializing: AtomicBool::new(true),
            runtime: Mutex::new(RuntimeState {
                relay: None,
                bridge: None,
            }),
            tray: Mutex::new(None),
            error: Mutex::new(String::new()),
            hook_installed: Mutex::new(false),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                let _operation = state.operation.lock().unwrap();
                let result = restart_active_backend(&handle, state.inner())
                    .and_then(|_| install_hook(state.inner()));
                #[cfg(target_os = "windows")]
                let result = result.and_then(|_| maybe_open_or_restart_accio().map(|_| ()));
                if let Err(err) = result {
                    let _ = stop_backend(state.inner());
                    switch_log(&format!("启动失败：{err}"));
                    *state.error.lock().unwrap() = err;
                }
                state.initializing.store(false, Ordering::SeqCst);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            upsert_provider,
            upsert_image_channel,
            delete_provider,
            get_status,
            apply_provider,
            restart_accio
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let _operation = state.operation.lock().unwrap();
                let hooked = *state.hook_installed.lock().unwrap() && accio_using_relay();
                let _ = stop_backend(state.inner());
                if !*state.hook_installed.lock().unwrap() {
                    return;
                }
                launchctl_unset("GATEWAY_BASE_URL");
                launchctl_unset("FAST_BUILD");
                if hooked && quit_accio().is_ok() {
                    let _ = open_accio();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_http_fixture(status: &str, body: &str) -> String {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://127.0.0.1:{port}/healthz")
    }

    #[test]
    fn novaferry_is_always_first_and_not_duplicated() {
        let cfg: AppConfig =
            serde_json::from_str(r#"{"activeProviderId":"official","providers":[]}"#).unwrap();
        let cfg = with_fixed_providers(with_fixed_providers(cfg));
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].id, NOVAFERRY_ID);
        assert_eq!(cfg.providers[0].endpoint, NOVAFERRY_ENDPOINT);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn config_dir_moves_legacy_accio_switch_dir() {
        let home = std::env::temp_dir().join(format!("ac-switch-home-{}", Uuid::new_v4()));
        fs::create_dir_all(home.join(".accio-switch/keys")).unwrap();
        fs::write(home.join(".accio-switch/config.json"), "{}").unwrap();
        fs::write(home.join(".accio-switch/keys/deepseek"), "sk-test").unwrap();
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        let dir = config_dir();
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(dir.unwrap(), home.join(".ac-switch"));
        assert!(!home.join(".accio-switch").exists());
        assert_eq!(fs::read_to_string(home.join(".ac-switch/keys/deepseek")).unwrap(), "sk-test");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn local_health_check_uses_http_status_and_json_body() {
        let ok = local_http_fixture("200 OK", r#"{"ok":true}"#);
        assert_eq!(curl_json(&ok).unwrap()["ok"], true);

        let failed = local_http_fixture("503 Service Unavailable", r#"{"ok":false}"#);
        assert!(!http_ok(&failed));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn node_paths_drop_windows_verbatim_prefix() {
        assert_eq!(
            node_compatible_path(Path::new(
                r"\\?\C:\Users\Example User\AC-Switch\sidecar\gateway-relay.cjs"
            )),
            PathBuf::from(r"C:\Users\Example User\AC-Switch\sidecar\gateway-relay.cjs")
        );
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\UNC\server\share\gateway-relay.cjs")),
            PathBuf::from(r"\\server\share\gateway-relay.cjs")
        );
        assert_eq!(
            node_compatible_path(Path::new(r"C:\plain\gateway-relay.cjs")),
            PathBuf::from(r"C:\plain\gateway-relay.cjs")
        );
    }

    #[test]
    fn legacy_config_defaults_image_channel() {
        let cfg: AppConfig =
            serde_json::from_str(r#"{"activeProviderId":"official","providers":[]}"#).unwrap();
        assert!(!cfg.image_channel.enabled);
    }

    #[test]
    fn credential_paths_cannot_escape() {
        for id in ["../secret", "/tmp/secret", "", "a/b", "..", "a\\b"] {
            assert!(key_file(id).is_err());
        }
    }

    #[test]
    fn foreign_listener_is_not_killed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(clear_owned_orphans(
            port,
            Path::new("/nonexistent/node"),
            Path::new("/nonexistent/relay.cjs")
        )
        .is_err());
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn owned_child_is_reaped() {
        let mut child = Some(command("/bin/sleep").arg("30").spawn().unwrap());
        let pid = child.as_ref().unwrap().id();
        stop_child(&mut child);
        assert!(child.is_none());
        assert!(!command("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
}
