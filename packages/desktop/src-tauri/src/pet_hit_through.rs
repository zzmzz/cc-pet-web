//! macOS: 透明宠物窗仅靠 CSS 无法穿透，需原生 `set_ignore_cursor_events`。
//! 后台线程按光标位置与前端同步的宠物可点击矩形动态切换鼠标穿透。
//!
//! 重要：所有 `win.*()` 查询（cursor_position / inner_position 等）在 Tauri v2 中
//! 内部通过 `run_on_main_thread` 同步分发，因此 **不能** 在主线程上阻塞等待后台线程，
//! 否则会死锁。`set_active` / `deactivate` 必须是非阻塞的。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static LAST_IGNORE: AtomicBool = AtomicBool::new(false);

type HitRect = (f64, f64, f64, f64);
static HIT_RECT: Mutex<Option<HitRect>> = Mutex::new(None);

fn default_hit_rect(inner_h: u32, scale: f64) -> HitRect {
    let h = inner_h as f64 / scale;
    let pad = 16.0;
    let side = 112.0;
    (pad, (h - pad - side).max(0.0), side, side)
}

fn compute_ignore_cursor(app: &AppHandle) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(cursor) = win.cursor_position() else {
        return false;
    };
    let Ok(inner_pos) = win.inner_position() else {
        return false;
    };
    let Ok(inner_sz) = win.inner_size() else {
        return false;
    };
    let Ok(scale) = win.scale_factor() else {
        return false;
    };

    let cx = cursor.x - inner_pos.x as f64;
    let cy = cursor.y - inner_pos.y as f64;
    let lx = cx / scale;
    let ly = cy / scale;

    let rect = HIT_RECT
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or_else(|| default_hit_rect(inner_sz.height, scale));

    let (rx, ry, rw, rh) = rect;
    let over = lx >= rx && lx <= rx + rw && ly >= ry && ly <= ry + rh;
    !over
}

fn run_loop(app: AppHandle) {
    while !STOP_REQUESTED.load(Ordering::Relaxed) {
        let ignore = compute_ignore_cursor(&app);
        let prev = LAST_IGNORE.load(Ordering::Relaxed);
        if prev != ignore {
            LAST_IGNORE.store(ignore, Ordering::Relaxed);
            let a = app.clone();
            let _ = a.clone().run_on_main_thread(move || {
                if let Some(w) = a.get_webview_window("main") {
                    let _ = w.set_ignore_cursor_events(ignore);
                }
            });
        }
        thread::sleep(Duration::from_millis(50));
    }

    // 退出时确保恢复
    LAST_IGNORE.store(false, Ordering::Relaxed);
    let a = app.clone();
    let _ = a.clone().run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window("main") {
            let _ = w.set_ignore_cursor_events(false);
        }
    });
}

/// 启动或停止穿透轮询。**非阻塞**——不 join 后台线程，避免死锁。
pub fn set_active(app: &AppHandle, enabled: bool) {
    if enabled {
        STOP_REQUESTED.store(false, Ordering::SeqCst);
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return; // 已经在跑
        }
        LAST_IGNORE.store(false, Ordering::Relaxed);
        let app = app.clone();
        thread::spawn(move || run_loop(app));
    } else {
        STOP_REQUESTED.store(true, Ordering::SeqCst);
        ACTIVE.store(false, Ordering::SeqCst);
        // 不 join——后台线程会在下一个 50ms 周期自行退出并恢复 ignore_cursor_events(false)。
        if let Ok(mut g) = HIT_RECT.lock() {
            *g = None;
        }
    }
}

pub fn update_hit_rect(x: f64, y: f64, width: f64, height: f64) {
    if let Ok(mut g) = HIT_RECT.lock() {
        *g = Some((x, y, width, height));
    }
}
