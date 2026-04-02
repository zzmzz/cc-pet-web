#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;

#[cfg(target_os = "macos")]
mod pet_hit_through;

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::window::Color;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, RunEvent, Size, WebviewWindow};

/// 与 `Layout` 宠物模式一致：`p-4` + `h-28 w-28`；锚点为宠物图**左下角**（水平 = 左内边距，垂直 = 底内边距线）。
const PET_PADDING_CSS: f64 = 16.0;
const CHAT_LOGICAL_W: f64 = 360.0;
const CHAT_LOGICAL_H: f64 = 500.0;

const CHAT_BOUNDS_FILENAME: &str = "chat_window_bounds.json";
const PET_POSITION_FILENAME: &str = "pet_position.json";
const PET_FIXED_MARGIN_PX: i32 = 16;
/// 内宽（逻辑像素）大于此值视为当前为聊天窗，关闭时写入持久化几何。
const CHAT_INNER_WIDTH_LOGICAL_THRESHOLD: f64 = 280.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatWindowBounds {
    inner_x: i32,
    inner_y: i32,
    inner_width: u32,
    inner_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PetPosition {
    x: i32,
    y: i32,
}

fn chat_bounds_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(CHAT_BOUNDS_FILENAME))
}

fn load_chat_bounds(app: &tauri::AppHandle) -> Option<ChatWindowBounds> {
    let path = chat_bounds_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_chat_bounds(app: &tauri::AppHandle, bounds: &ChatWindowBounds) -> Result<(), String> {
    let path = chat_bounds_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(bounds).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn pet_position_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(PET_POSITION_FILENAME))
}

fn load_pet_position(app: &tauri::AppHandle) -> Option<PetPosition> {
    let path = pet_position_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_pet_position_to_disk(app: &tauri::AppHandle, pos: &PetPosition) -> Result<(), String> {
    let path = pet_position_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(pos).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn clamp_bounds_to_work_area(bounds: ChatWindowBounds, mon: &tauri::Monitor) -> Option<ChatWindowBounds> {
    let work = mon.work_area();
    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let bw = bounds.inner_width as i32;
    let bh = bounds.inner_height as i32;
    if bw < 120 || bh < 120 || bw > ww || bh > wh {
        return None;
    }
    let mut x = bounds.inner_x;
    let mut y = bounds.inner_y;
    x = x.clamp(wx, wx + ww - bw);
    y = y.clamp(wy, wy + wh - bh);
    Some(ChatWindowBounds {
        inner_x: x,
        inner_y: y,
        inner_width: bounds.inner_width,
        inner_height: bounds.inner_height,
    })
}

fn primary_or_current_monitor(window: &WebviewWindow) -> Option<tauri::Monitor> {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
}

const PET_LOGICAL_W: f64 = 200.0;
const PET_LOGICAL_H: f64 = 220.0;

/// 恢复宠物窗位置：优先用磁盘记录的拖拽位置，fallback 到工作区右下角。
fn restore_pet_position(window: &WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pw = (PET_LOGICAL_W * scale).ceil() as i32;
    let ph = (PET_LOGICAL_H * scale).ceil() as i32;

    if let Some(saved) = load_pet_position(app) {
        if let Some(mon) = primary_or_current_monitor(window) {
            let work = mon.work_area();
            let wx = work.position.x;
            let wy = work.position.y;
            let ww = work.size.width as i32;
            let wh = work.size.height as i32;
            let x = saved.x.clamp(wx, wx + ww - pw);
            let y = saved.y.clamp(wy, wy + wh - ph);
            return window
                .set_position(Position::Physical(PhysicalPosition::new(x, y)))
                .map_err(|e| e.to_string());
        }
        return window
            .set_position(Position::Physical(PhysicalPosition::new(saved.x, saved.y)))
            .map_err(|e| e.to_string());
    }

    let Some(mon) = primary_or_current_monitor(window) else {
        return Ok(());
    };
    let work = mon.work_area();
    let wx = work.position.x;
    let wy = work.position.y;
    let ww = work.size.width as i32;
    let wh = work.size.height as i32;
    let nx = wx + ww - pw - PET_FIXED_MARGIN_PX;
    let ny = wy + wh - ph - PET_FIXED_MARGIN_PX;
    window
        .set_position(Position::Physical(PhysicalPosition::new(nx, ny)))
        .map_err(|e| e.to_string())
}

fn is_likely_chat_sized_window(window: &WebviewWindow) -> bool {
    let Ok(sz) = window.inner_size() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let w_logical = sz.width as f64 / scale;
    w_logical > CHAT_INNER_WIDTH_LOGICAL_THRESHOLD
}

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

/// 登录页（URL + Token）：宠物默认窗口过小，放大并置于工作区居中。
const LOGIN_WINDOW_LOGICAL_W: f64 = 520.0;
const LOGIN_WINDOW_LOGICAL_H: f64 = 680.0;

fn apply_login_window_layout(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: LOGIN_WINDOW_LOGICAL_W,
            height: LOGIN_WINDOW_LOGICAL_H,
        }))
        .map_err(|e| e.to_string())?;
    window
        .set_background_color(Some(Color(248, 250, 252, 255)))
        .map_err(|e| e.to_string())?;
    if let Some(mon) = primary_or_current_monitor(window) {
        let work = mon.work_area();
        let scale = window.scale_factor().unwrap_or(1.0);
        let inner_w = (LOGIN_WINDOW_LOGICAL_W * scale).round() as i32;
        let inner_h = (LOGIN_WINDOW_LOGICAL_H * scale).round() as i32;
        let wx = work.position.x;
        let wy = work.position.y;
        let ww = work.size.width as i32;
        let wh = work.size.height as i32;
        let nx = wx + (ww - inner_w).max(0) / 2;
        let ny = wy + (wh - inner_h).max(0) / 2;
        window
            .set_position(Position::Physical(PhysicalPosition::new(nx, ny)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn prepare_login_window(window: WebviewWindow) -> Result<(), String> {
    apply_login_window_layout(&window)
}

#[tauri::command]
fn set_window_mode(
    window: WebviewWindow,
    mode: String,
    preserve_size: bool,
    anchor_from_pet: bool,
    pet_always_on_top: bool,
    chat_always_on_top: bool,
) -> Result<(), String> {
    let mode = mode.as_str();
    let _ = preserve_size;
    let app = window.app_handle();

    // 从 pet 切到 chat 时，记录当前宠物位置以便下次恢复
    if mode == "chat" {
        if let Ok(pos) = window.inner_position() {
            let _ = save_pet_position_to_disk(&app, &PetPosition { x: pos.x, y: pos.y });
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
            if is_likely_chat_sized_window(&window) {
                if let (Ok(pos), Ok(sz)) = (window.inner_position(), window.inner_size()) {
                    let bounds = ChatWindowBounds {
                        inner_x: pos.x,
                        inner_y: pos.y,
                        inner_width: sz.width,
                        inner_height: sz.height,
                    };
                    let _ = save_chat_bounds(&app, &bounds);
                }
            }
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: 200.0,
                    height: 220.0,
                }))
                .map_err(|e| e.to_string())?;
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
                .map_err(|e| e.to_string())?;
            window
                .set_always_on_top(pet_always_on_top)
                .map_err(|e| e.to_string())?;
            restore_pet_position(&window, &app)?;
        }
        "chat" => {
            let restored = load_chat_bounds(&app)
                .and_then(|b| primary_or_current_monitor(&window).and_then(|m| clamp_bounds_to_work_area(b, &m)));
            if let Some(b) = restored {
                window
                    .set_size(Size::Physical(PhysicalSize::new(b.inner_width, b.inner_height)))
                    .map_err(|e| e.to_string())?;
                window
                    .set_background_color(Some(Color(248, 250, 252, 255)))
                    .map_err(|e| e.to_string())?;
                window
                    .set_always_on_top(chat_always_on_top)
                    .map_err(|e| e.to_string())?;
                window
                    .set_position(Position::Physical(PhysicalPosition::new(b.inner_x, b.inner_y)))
                    .map_err(|e| e.to_string())?;
            } else {
                window
                    .set_size(tauri::Size::Logical(tauri::LogicalSize {
                        width: CHAT_LOGICAL_W,
                        height: CHAT_LOGICAL_H,
                    }))
                    .map_err(|e| e.to_string())?;
                window
                    .set_background_color(Some(Color(248, 250, 252, 255)))
                    .map_err(|e| e.to_string())?;
                window
                    .set_always_on_top(chat_always_on_top)
                    .map_err(|e| e.to_string())?;
                if let Some((ax, ay, scale)) = pet_anchor_physical {
                    let nx = ax.round() as i32;
                    let ny = (ay - CHAT_LOGICAL_H * scale).round() as i32;
                    window
                        .set_position(Position::Physical(PhysicalPosition::new(nx, ny)))
                        .map_err(|e| e.to_string())?;
                }
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
fn save_pet_position(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let pos = window.inner_position().map_err(|e| e.to_string())?;
    save_pet_position_to_disk(&app, &PetPosition { x: pos.x, y: pos.y })
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
            save_pet_position,
            toggle_window_visibility,
            quit_app,
            prepare_login_window,
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
