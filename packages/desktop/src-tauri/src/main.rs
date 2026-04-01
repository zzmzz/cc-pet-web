#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::WebviewWindow;

#[tauri::command]
fn set_window_mode(window: WebviewWindow, mode: String) -> Result<(), String> {
    match mode.as_str() {
        "pet" => {
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: 200.0,
                    height: 220.0,
                }))
                .map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
        }
        "chat" => {
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: 360.0,
                    height: 500.0,
                }))
                .map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
        }
        "settings" => {
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: 400.0,
                    height: 600.0,
                }))
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown mode: {mode}")),
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, value: bool) -> Result<(), String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_opacity(_window: WebviewWindow, _value: f64) -> Result<(), String> {
    // Tauri v2 does not expose a cross-platform window opacity API directly.
    Ok(())
}

#[tauri::command]
fn start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_window_mode,
            set_always_on_top,
            set_opacity,
            start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
