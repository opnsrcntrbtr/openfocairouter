//! Tauri shell: spawns the TypeScript router as a sidecar, owns the tray icon,
//! and hands the per-launch admin token to the UI.
use std::io::Read;
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct AdminToken(String);
struct RouterPort(u16);
struct RouterChild(Mutex<Option<CommandChild>>);

#[tauri::command]
fn admin_token(state: tauri::State<AdminToken>) -> String {
    state.0.clone()
}

#[tauri::command]
fn router_port(state: tauri::State<RouterPort>) -> u16 {
    state.0
}

/// 24 random bytes from the OS, hex-encoded.
fn random_token() -> String {
    let mut buf = [0u8; 24];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("read /dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn stop_router(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<RouterChild>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = random_token();
    let port: u16 = std::env::var("OFR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4141);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AdminToken(token.clone()))
        .manage(RouterPort(port))
        .invoke_handler(tauri::generate_handler![admin_token, router_port])
        .setup(move |app| {
            // --- Router sidecar ---
            let (mut rx, child) = app
                .shell()
                .sidecar("ofr-router")?
                .env("OFR_ADMIN_TOKEN", &token)
                .env("OFR_PORT", port.to_string())
                .spawn()?;
            app.manage(RouterChild(Mutex::new(Some(child))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            println!("{}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(t) => {
                            eprintln!("[ofr] router exited: {:?}", t.code);
                        }
                        _ => {}
                    }
                }
            });

            // --- Menu bar (tray) ---
            let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let endpoint = MenuItem::with_id(app, "endpoint", format!("Endpoint: 127.0.0.1:{port}/v1"), false, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit OpenFOC AI Router", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &endpoint, &sep, &quit])?;
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
        // Closing the window keeps the router running in the menu bar.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
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
