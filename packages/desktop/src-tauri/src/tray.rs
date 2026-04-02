//! 系统托盘 / 菜单栏图标：左键显示主窗口，右键菜单可显示/隐藏、打开设置或退出。

use tauri::{
    include_image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, EventTarget, Manager,
};

pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let toggle_i = MenuItem::with_id(handle, "tray-toggle", "显示/隐藏", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(handle, "tray-settings", "设置", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(handle, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&toggle_i, &settings_i, &quit_i])?;

    let fallback = include_image!("icons/tray.png");
    let icon = handle
        .default_window_icon()
        .map(|i| i.clone())
        .unwrap_or(fallback);

    let _ = TrayIconBuilder::with_id("cc-pet-tray")
        .tooltip("CC Pet")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "tray-quit" => {
                app.exit(0);
            }
            "tray-toggle" => {
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(true);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "tray-settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = crate::apply_settings_window_layout(&window);
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit_to(
                        EventTarget::webview_window("main"),
                        "cc-pet-open-settings",
                        (),
                    );
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(handle);

    Ok(())
}
