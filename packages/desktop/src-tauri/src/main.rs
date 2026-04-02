#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;

#[cfg(target_os = "macos")]
mod pet_hit_through;

use std::sync::Mutex;

use tauri::{Manager, PhysicalPosition, Position, RunEvent, WebviewWindow};
use tauri::window::Color;

/// 经锚点打开聊天前的小窗 `inner_position`；切回宠物时恢复，避免只改尺寸导致宠物在屏幕上漂移。
static PET_INNER_POS_BEFORE_ANCHORED_CHAT: Mutex<Option<PhysicalPosition<i32>>> = Mutex::new(None);

/// 与 `Layout` 宠物模式一致：`p-4` + `h-28 w-28`；锚点为宠物图**左下角**（水平 = 左内边距，垂直 = 底内边距线）。
const PET_PADDING_CSS: f64 = 16.0;
const CHAT_LOGICAL_W: f64 = 360.0;
const CHAT_LOGICAL_H: f64 = 500.0;

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

pub(crate) fn apply_settings_window_layout(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 400.0,
            height: 600.0,
        }))
        .map_err(|e| e.to_string())?;
    window
        .set_background_color(Some(Color(248, 250, 252, 255)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_window_mode(
    window: WebviewWindow,
    mode: String,
    preserve_size: bool,
    anchor_from_pet: bool,
) -> Result<(), String> {
    let mode = mode.as_str();
    let _ = preserve_size;

    if mode == "chat" && anchor_from_pet {
        if let Ok(p) = window.inner_position() {
            if let Ok(mut g) = PET_INNER_POS_BEFORE_ANCHORED_CHAT.lock() {
                *g = Some(p);
            }
        }
    }

    let pet_anchor_physical = if mode == "chat" && anchor_from_pet {
        let inner_pos = window.inner_position().ok();
        let inner_sz = window.inner_size().ok();
        let scale = window.scale_factor().unwrap_or(1.0);
        if let (Some(pos), Some(sz)) = (inner_pos, inner_sz) {
            let inner_h_css = sz.height as f64 / scale;
            let anchor_rel_x = PET_PADDING_CSS;
            let anchor_rel_y = inner_h_css - PET_PADDING_CSS;
            let ax = pos.x as f64 + anchor_rel_x * scale;
            let ay = pos.y as f64 + anchor_rel_y * scale;
            Some((ax, ay, scale))
        } else {
            None
        }
    } else {
        None
    };

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
            if let Ok(mut g) = PET_INNER_POS_BEFORE_ANCHORED_CHAT.lock() {
                if let Some(p) = g.take() {
                    window
                        .set_position(Position::Physical(p))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        "chat" => {
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: CHAT_LOGICAL_W,
                    height: CHAT_LOGICAL_H,
                }))
                .map_err(|e| e.to_string())?;
            window
                .set_background_color(Some(Color(248, 250, 252, 255)))
                .map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
            if let Some((ax, ay, scale)) = pet_anchor_physical {
                let nx = ax.round() as i32;
                let ny = (ay - CHAT_LOGICAL_H * scale).round() as i32;
                window
                    .set_position(Position::Physical(PhysicalPosition::new(nx, ny)))
                    .map_err(|e| e.to_string())?;
            }
        }
        "settings" => {
            apply_settings_window_layout(&window)?;
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
        .setup(|app| {
            tray::init(app)?;
            Ok(())
        })
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_handle, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
