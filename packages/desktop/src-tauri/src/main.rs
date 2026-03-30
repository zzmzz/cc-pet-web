#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn set_window_mode(window: tauri::Window, mode: String) -> Result<(), String> {
    match mode.as_str() {
        "pet" => {
            window.set_size(tauri::LogicalSize::new(200.0, 220.0)).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
        }
        "chat" => {
            window.set_size(tauri::LogicalSize::new(360.0, 500.0)).map_err(|e| e.to_string())?;
        }
        "settings" => {
            window.set_size(tauri::LogicalSize::new(400.0, 600.0)).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown mode: {mode}")),
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, value: bool) -> Result<(), String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_opacity(window: tauri::Window, value: f64) -> Result<(), String> {
    window.set_opacity(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_drag(window: tauri::Window) -> Result<(), String> {
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
