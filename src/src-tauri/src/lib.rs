use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageFormat;
use serde::Serialize;
use std::io::Cursor;
use tauri_plugin_dialog::DialogExt;

/// Metadata about an available monitor.
#[derive(Serialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// Base64-encoded image with its MIME type.
#[derive(Serialize)]
pub struct Base64Image {
    /// The base64-encoded image data.
    pub data: String,
    /// The MIME type of the image (e.g. "image/png").
    pub mime_type: String,
}

/// Lists all available monitors with their metadata.
#[tauri::command]
fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to list monitors: {e}"))?;

    Ok(monitors
        .into_iter()
        .map(|m| MonitorInfo {
            id: m.id(),
            name: m.name().to_string(),
            width: m.width(),
            height: m.height(),
            is_primary: m.is_primary(),
        })
        .collect())
}

/// Captures a screenshot of the specified monitor (by index) and returns it as
/// a base64-encoded PNG. If no index is provided, the primary monitor is used.
#[tauri::command]
async fn capture_monitor_screenshot(monitor_index: Option<usize>) -> Result<Base64Image, String> {
    // Run the blocking screenshot capture on a background thread
    tauri::async_runtime::spawn_blocking(move || {
        let monitors =
            xcap::Monitor::all().map_err(|e| format!("Failed to list monitors: {e}"))?;

        if monitors.is_empty() {
            return Err("No monitors found".to_string());
        }

        let monitor = match monitor_index {
            Some(idx) => monitors
                .get(idx)
                .ok_or_else(|| format!("Monitor index {idx} out of range (0..{})", monitors.len()))?,
            None => monitors
                .iter()
                .find(|m| m.is_primary())
                .unwrap_or(&monitors[0]),
        };

        let rgba_image = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture screenshot: {e}"))?;

        // Encode the RGBA image as PNG into a byte buffer
        let mut png_bytes: Vec<u8> = Vec::new();
        rgba_image
            .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
            .map_err(|e| format!("Failed to encode screenshot as PNG: {e}"))?;

        Ok(Base64Image {
            data: STANDARD.encode(&png_bytes),
            mime_type: "image/png".to_string(),
        })
    })
    .await
    .map_err(|e| format!("Screenshot task failed: {e}"))?
}

/// Opens a native file dialog filtered to image types.
/// Returns the selected image as a base64-encoded string with its MIME type,
/// or `null` if the user cancelled the dialog.
#[tauri::command]
async fn pick_image_file(app: tauri::AppHandle) -> Result<Option<Base64Image>, String> {
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"])
        .set_title("Select an image")
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    // Wait for the user's selection on a blocking thread to avoid stalling the async runtime
    let file_path = tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog channel error: {e}"))
    })
    .await
    .map_err(|e| format!("Dialog task failed: {e}"))??;

    match file_path {
        Some(path) => {
            let path_buf = path.into_path().map_err(|e| format!("Invalid path: {e}"))?;

            let bytes = std::fs::read(&path_buf)
                .map_err(|e| format!("Failed to read file: {e}"))?;

            // Determine MIME type from extension
            let mime_type = match path_buf
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_lowercase())
                .as_deref()
            {
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("gif") => "image/gif",
                Some("webp") => "image/webp",
                Some("bmp") => "image/bmp",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };

            Ok(Some(Base64Image {
                data: STANDARD.encode(&bytes),
                mime_type: mime_type.to_string(),
            }))
        }
        None => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_monitors,
            capture_monitor_screenshot,
            pick_image_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
