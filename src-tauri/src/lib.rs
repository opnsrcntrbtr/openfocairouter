//! Tauri shell: spawns the TypeScript router as a sidecar, owns the macOS
//! Keychain (secrets go to the router over stdin, never env/argv/disk), the
//! tray icon, launch at login, and hands the per-launch admin token to the UI.
use std::io::Read;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const KEYCHAIN_SERVICE: &str = "dev.openfoc.airouter";
const SHELL_PREFIX: &str = "@@ofr ";

struct AdminToken(String);
struct RouterPort(u16);
struct RouterChild(Mutex<Option<CommandChild>>);

/// Messages the router sends on stdout (prefixed, never echoed to logs).
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum RouterMsg {
    /// Router asks for these Keychain accounts at startup.
    Need { accounts: Vec<String> },
    /// Router hands over a plaintext key found in a v0.1 config (one-time migration).
    Store { account: String, value: String },
}

fn valid_account(account: &str) -> bool {
    let mut parts = account.splitn(2, ':');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().unwrap_or("");
    (kind == "provider" || kind == "client")
        && !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn keychain_get(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).ok()?.get_password().ok()
}

fn keychain_set(account: &str, value: Option<&str>) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())?;
    match value {
        Some(v) if !v.is_empty() => entry.set_password(v).map_err(|e| e.to_string()),
        _ => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// Write one JSON line to the router's stdin.
fn send_to_router(app: &AppHandle, msg: serde_json::Value) {
    if let Some(state) = app.try_state::<RouterChild>() {
        if let Some(child) = state.0.lock().unwrap().as_mut() {
            let mut line = msg.to_string();
            line.push('\n');
            let _ = child.write(line.as_bytes());
        }
    }
}

#[tauri::command]
fn admin_token(state: tauri::State<AdminToken>) -> String {
    state.0.clone()
}

#[tauri::command]
fn router_port(state: tauri::State<RouterPort>) -> u16 {
    state.0
}

/// Save (or delete, when `value` is null/empty) a secret in the Keychain and pass it to the router.
#[tauri::command]
fn set_secret(app: AppHandle, account: String, value: Option<String>) -> Result<(), String> {
    if !valid_account(&account) {
        return Err("invalid account".into());
    }
    let v = value.as_deref().map(str::trim).filter(|s| !s.is_empty());
    keychain_set(&account, v)?;
    if account.starts_with("provider:") {
        match v {
            Some(v) => send_to_router(&app, serde_json::json!({ "op": "set", "account": account, "value": v })),
            None => send_to_router(&app, serde_json::json!({ "op": "delete", "account": account })),
        }
    }
    Ok(())
}

/// Client keys can be read back (to copy into a tool again); provider keys never leave the Keychain to the UI.
#[tauri::command]
fn get_client_key(id: String) -> Result<Option<String>, String> {
    let account = format!("client:{id}");
    if !valid_account(&account) {
        return Err("invalid client id".into());
    }
    Ok(keychain_get(&account))
}

/// 24 random bytes from the OS, hex-encoded.
fn random_token() -> String {
    let mut buf = [0u8; 24];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("read /dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

fn show_main(app: &AppHandle) {
    set_dock_visible(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn stop_router(app: &AppHandle) {
    if let Some(state) = app.try_state::<RouterChild>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

fn handle_router_line(app: &AppHandle, line: &str) -> bool {
    let Some(json) = line.strip_prefix(SHELL_PREFIX) else { return false };
    match serde_json::from_str::<RouterMsg>(json) {
        Ok(RouterMsg::Need { accounts }) => {
            for account in accounts.iter().filter(|a| valid_account(a)) {
                if let Some(value) = keychain_get(account) {
                    send_to_router(app, serde_json::json!({ "op": "set", "account": account, "value": value }));
                }
            }
            send_to_router(app, serde_json::json!({ "op": "ready" }));
        }
        Ok(RouterMsg::Store { account, value }) => {
            if valid_account(&account) {
                if let Err(e) = keychain_set(&account, Some(&value)) {
                    eprintln!("[ofr] keychain write failed for {account}: {e}");
                }
            }
        }
        Err(e) => eprintln!("[ofr] ignored router message: {e}"),
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = random_token();
    let port: u16 = std::env::var("OFR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4141);
    let hidden = std::env::args().any(|a| a == "--hidden");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AdminToken(token.clone()))
        .manage(RouterPort(port))
        .invoke_handler(tauri::generate_handler![admin_token, router_port, set_secret, get_client_key])
        .setup(move |app| {
            let handle = app.handle().clone();

            // --- Router sidecar ---
            let (mut rx, child) = app
                .shell()
                .sidecar("ofr-router")?
                .env("OFR_ADMIN_TOKEN", &token)
                .env("OFR_PORT", port.to_string())
                .env("OFR_SECRETS", "stdin")
                .spawn()?;
            app.manage(RouterChild(Mutex::new(Some(child))));
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                if !handle_router_line(&h, line) {
                                    println!("{line}");
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => eprintln!("{}", String::from_utf8_lossy(&bytes).trim_end()),
                        CommandEvent::Terminated(t) => eprintln!("[ofr] router exited: {:?}", t.code),
                        _ => {}
                    }
                }
            });

            // --- Window: hidden at login, shown otherwise ---
            if hidden {
                set_dock_visible(&handle, false);
            } else {
                show_main(&handle);
            }

            // --- Menu bar (tray) ---
            let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let endpoint = MenuItem::with_id(app, "endpoint", format!("OpenAI: 127.0.0.1:{port}/v1"), false, None::<&str>)?;
            let anthropic = MenuItem::with_id(app, "anthropic", format!("Anthropic: 127.0.0.1:{port}"), false, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit OpenFOC AI Router", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &endpoint, &anthropic, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("OpenFOC AI Router")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        stop_router(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // Closing the window keeps the router running in the menu bar (and drops the Dock icon).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                set_dock_visible(window.app_handle(), false);
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenFOC AI Router");

    app.run(|handle, event| match event {
        RunEvent::Exit => stop_router(handle),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        _ => {}
    });
}
