use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};
use uuid::Uuid;

const RELAY_PORT: u16 = 18767;
const BRIDGE_PORT: u16 = 18765;
const RELAY_URL: &str = "http://127.0.0.1:18767";
const BRIDGE_URL: &str = "http://127.0.0.1:18765";
const ACCIO_APP: &str = "/Applications/Accio.app";
const KEYCHAIN_SERVICE: &str = "accio-switch";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub reasoning_effort: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub active_provider_id: String,
    pub providers: Vec<Provider>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub accio_running: bool,
    pub relay_ok: bool,
    pub bridge_ok: bool,
    pub active_provider_id: String,
    pub hook: String,
}

struct RuntimeState {
    relay: Option<Child>,
    bridge: Option<Child>,
}

struct AppState {
    runtime: Mutex<RuntimeState>,
}

fn config_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "home directory not found".to_string())?
        .join(".accio-switch");
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
            has_key: false,
        }],
    }
}

fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let cfg = default_config();
        save_config(&cfg)?;
        return Ok(cfg);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path()?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn keychain_set(account: &str, secret: &str) -> Result<(), String> {
    let status = Command::new("security")
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

fn keychain_get(account: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

fn keychain_delete(account: &str) {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
        .status();
}

fn with_has_key(mut provider: Provider) -> Provider {
    provider.has_key = keychain_get(&provider.id).ok().flatten().is_some();
    provider
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

fn node_bin() -> PathBuf {
    ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn http_ok(url: &str) -> bool {
    Command::new("curl")
        .args(["-fsS", "--max-time", "1", url])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn accio_running() -> bool {
    Command::new("pgrep")
        .args(["-x", "Accio"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn quit_accio() {
    let _ = Command::new("osascript")
        .args(["-e", "quit app \"Accio\""])
        .status();
    std::thread::sleep(Duration::from_millis(1200));
}

fn launchctl_set(key: &str, value: &str) -> Result<(), String> {
    Command::new("launchctl")
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

fn launchctl_unset(key: &str) {
    let _ = Command::new("launchctl").args(["unsetenv", key]).status();
}

fn open_accio() -> Result<(), String> {
    if !Path::new(ACCIO_APP).exists() {
        return Err("未找到 /Applications/Accio.app".into());
    }
    Command::new("open")
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

fn spawn_node(script: &Path, extra_env: &[(&str, String)]) -> Result<Child, String> {
    let mut cmd = Command::new(node_bin());
    cmd.arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.spawn().map_err(|e| format!("failed to start {}: {e}", script.display()))
}

fn kill_port(port: u16) {
    if let Ok(output) = Command::new("lsof")
        .args(["-nP", "-tiTCP", &format!(":{port}"), "-sTCP:LISTEN"])
        .output()
    {
        for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
            let _ = Command::new("kill").args(["-9", pid]).status();
        }
    }
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

fn start_backend(app: &AppHandle, state: &AppState, provider: &Provider) -> Result<(), String> {
    let sidecar = sidecar_dir(app)?;
    let relay_script = sidecar.join("gateway-relay.cjs");
    let bridge_script = sidecar.join("openai-bridge.cjs");
    if !relay_script.exists() || !bridge_script.exists() {
        return Err(format!("sidecar missing in {}", sidecar.display()));
    }
    let key = keychain_get(&provider.id)?.unwrap_or_default();
    let log_dir = config_dir()?;
    let api_provider = if provider.kind == "custom_openai" {
        "custom_openai"
    } else {
        "opencode_go"
    };
    let auth_type = if key.is_empty() { "none" } else { "api_key" };

    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    stop_child(&mut runtime.relay);
    stop_child(&mut runtime.bridge);
    kill_port(BRIDGE_PORT);
    kill_port(RELAY_PORT);

    let bridge_env = vec![
        ("ACCIO_OPENCODE_PORT", BRIDGE_PORT.to_string()),
        ("OPENCODE_GO_MODEL", provider.model.clone()),
        ("OPENCODE_GO_ENDPOINT", provider.endpoint.clone()),
        ("OPENCODE_GO_REASONING_EFFORT", provider.reasoning_effort.clone()),
        ("ACCIO_MODEL_AUTH_TYPE", auth_type.to_string()),
        ("ACCIO_API_PROVIDER", api_provider.to_string()),
        ("OPENCODE_GO_API_KEY", key),
    ];
    runtime.bridge = Some(spawn_node(&bridge_script, &bridge_env)?);

    let relay_env = vec![
        ("ACCIO_RELAY_PORT", RELAY_PORT.to_string()),
        ("ACCIO_MODEL_BRIDGE_URL", BRIDGE_URL.to_string()),
        (
            "ACCIO_RELAY_LOG",
            log_dir.join("relay.log").to_string_lossy().to_string(),
        ),
    ];
    runtime.relay = Some(spawn_node(&relay_script, &relay_env)?);
    drop(runtime);

    wait_health(&format!("{BRIDGE_URL}/healthz"))?;
    wait_health(&format!("{RELAY_URL}/healthz"))?;
    Ok(())
}

fn stop_backend(state: &AppState) -> Result<(), String> {
    let mut runtime = state.runtime.lock().map_err(|e| e.to_string())?;
    stop_child(&mut runtime.relay);
    stop_child(&mut runtime.bridge);
    kill_port(BRIDGE_PORT);
    kill_port(RELAY_PORT);
    Ok(())
}

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let mut cfg = load_config()?;
    for provider in &mut cfg.providers {
        *provider = with_has_key(provider.clone());
    }
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
    api_key: Option<String>,
}

#[tauri::command]
fn upsert_provider(
    app: AppHandle,
    state: State<AppState>,
    input: UpsertProviderInput,
) -> Result<AppConfig, String> {
    if input.kind != "opencode_go" && input.kind != "custom_openai" {
        return Err("unsupported provider kind".into());
    }
    let mut cfg = load_config()?;
    let id = input
        .id
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Some(key) = input.api_key {
        let trimmed = key.trim().to_string();
        if trimmed.is_empty() {
            keychain_delete(&id);
        } else {
            keychain_set(&id, &trimmed)?;
        }
    }
    let provider = with_has_key(Provider {
        id: id.clone(),
        kind: input.kind,
        name: input.name,
        endpoint: input.endpoint,
        model: input.model,
        reasoning_effort: input.reasoning_effort,
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
    get_config()
}

#[tauri::command]
fn delete_provider(id: String) -> Result<AppConfig, String> {
    let mut cfg = load_config()?;
    if cfg.active_provider_id == id {
        cfg.active_provider_id = "official".into();
    }
    cfg.providers.retain(|p| p.id != id);
    keychain_delete(&id);
    save_config(&cfg)?;
    get_config()
}

#[tauri::command]
fn get_status() -> Result<AppStatus, String> {
    let cfg = load_config()?;
    Ok(AppStatus {
        accio_running: accio_running(),
        relay_ok: http_ok(&format!("{RELAY_URL}/healthz")),
        bridge_ok: http_ok(&format!("{BRIDGE_URL}/healthz")),
        active_provider_id: cfg.active_provider_id,
        hook: "gateway_base_url".into(),
    })
}

#[tauri::command]
fn apply_provider(app: AppHandle, state: State<AppState>, id: String) -> Result<AppStatus, String> {
    let mut cfg = load_config()?;
    if id == "official" {
        stop_backend(&state)?;
        launchctl_unset("GATEWAY_BASE_URL");
        launchctl_unset("FAST_BUILD");
        cfg.active_provider_id = "official".into();
        save_config(&cfg)?;
        quit_accio();
        open_accio()?;
        return get_status();
    }
    let provider = cfg
        .providers
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| "provider not found".to_string())?;
    start_backend(&app, &state, &provider)?;
    launchctl_set("GATEWAY_BASE_URL", RELAY_URL)?;
    launchctl_set("FAST_BUILD", "true")?;
    cfg.active_provider_id = id;
    save_config(&cfg)?;
    quit_accio();
    open_accio()?;
    get_status()
}

#[tauri::command]
fn restart_accio() -> Result<AppStatus, String> {
    quit_accio();
    open_accio()?;
    get_status()
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let open_item = MenuItem::with_id(app, "open", "打开 Accio Switch", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "退出托盘", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item]).map_err(|e| e.to_string())?;
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png")).map_err(|e| e.to_string())?;
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            runtime: Mutex::new(RuntimeState {
                relay: None,
                bridge: None,
            }),
        })
        .setup(|app| {
            build_tray(&app.handle()).ok();
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
            delete_provider,
            get_status,
            apply_provider,
            restart_accio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
