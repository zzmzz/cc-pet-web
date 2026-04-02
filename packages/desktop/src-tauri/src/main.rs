#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod pet_hit_through;

use tauri::{Manager, WebviewWindow};
use tauri::window::Color;

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_pet_hit_through_enabled(app: tauri::AppHandle, enabled: bool) {
    pet_hit_through::set_active(&app, enabled);
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn update_pet_hit_rect(x: f64, y: f64, width: f64, height: f64) {
    pet_hit_through::update_hit_rect(x, y, width, height);
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_pet_hit_through_enabled(_app: tauri::AppHandle, _enabled: bool) {}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn update_pet_hit_rect(_x: f64, _y: f64, _width: f64, _height: f64) {}

#[tauri::command]
fn set_window_mode(window: WebviewWindow, mode: String, preserve_size: bool) -> Result<(), String> {
    let mode = mode.as_str();
    let _ = preserve_size;
    match mode {
        "pet" => {
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: 200.0,
                    height: 220.0,
                }))
                .map_err(|e| e.to_string())?;
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
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
            window
                .set_background_color(Some(Color(248, 250, 252, 255)))
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
            window
                .set_background_color(Some(Color(248, 250, 252, 255)))
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

#[tauri::command]
fn toggle_window_visibility(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    if visible {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_window_mode,
            set_always_on_top,
            set_opacity,
            start_drag,
            toggle_window_visibility,
            quit_app,
            set_pet_hit_through_enabled,
            update_pet_hit_rect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
