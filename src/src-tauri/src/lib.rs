use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageFormat;
use img_hash::{HasherConfig, ImageHash};
use regex::Regex;
use serde::Serialize;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// State for an active watch session.
pub struct WatchSession {
    pub window_id: u32,
    pub last_hash: Option<ImageHash>,
    pub last_question: Option<String>,
    pub is_running: bool,
    pub stop_flag: Arc<AtomicBool>,
}

/// Event emitted to the frontend during watch.
#[derive(Serialize, Clone)]
pub struct WatchEvent {
    pub event_type: String,
    pub question: Option<String>,
    pub raw_text: Option<String>,
    pub timestamp_ms: u64,
}

/// Status response for get_watch_status.
#[derive(Serialize)]
pub struct WatchStatus {
    pub is_running: bool,
    pub window_id: Option<u32>,
    pub last_question: Option<String>,
}

/// Shared watch state managed by Tauri.
pub type WatchState = Mutex<Option<WatchSession>>;

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

/// Metadata about an available window.
#[derive(Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub width: u32,
    pub height: u32,
    pub is_minimized: bool,
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn compute_hash(rgba_image: &image::RgbaImage) -> ImageHash {
    let compatible = img_hash::image::RgbaImage::from_raw(
        rgba_image.width(),
        rgba_image.height(),
        rgba_image.clone().into_raw(),
    )
    .expect("xcap returned invalid RGBA image dimensions");
    let dynamic = img_hash::image::DynamicImage::ImageRgba8(compatible);
    let hasher = HasherConfig::new().to_hasher();
    hasher.hash_image(&dynamic)
}

fn detect_question(text: &str) -> Option<String> {
    // Pattern 1: Any question mark
    let question_mark_re = Regex::new(r"\?").unwrap();
    if question_mark_re.is_match(text) {
        // Try to extract the sentence containing '?'
        // Find the segment right before a '?' by looking at the original text
        for (i, ch) in text.char_indices() {
            if ch == '?' {
                // Walk backwards to find sentence start
                let start = text[..i]
                    .rfind(|c| c == '.' || c == '!' || c == '\n')
                    .map(|p| p + 1)
                    .unwrap_or(0);
                let sentence = text[start..=i].trim();
                if !sentence.is_empty() {
                    let truncated: String = sentence.chars().take(500).collect();
                    return Some(truncated);
                }
            }
        }
        // Fallback: first 500 chars
        let truncated: String = text.chars().take(500).collect();
        return Some(truncated);
    }

    // Pattern 2: Numbered quiz items (Q1., Q2))
    let quiz_re = Regex::new(r"(?i)\bQ\d+[\.)]").unwrap();
    if quiz_re.is_match(text) {
        let truncated: String = text.chars().take(500).collect();
        return Some(truncated);
    }

    // Pattern 3: Question-word sentence start (check each line)
    let question_word_re =
        Regex::new(r"(?i)^(which|what|who|when|where|how|why)\b").unwrap();
    for line in text.lines() {
        if question_word_re.is_match(line.trim()) {
            let truncated: String = text.chars().take(500).collect();
            return Some(truncated);
        }
    }

    // Pattern 4: Common quiz phrases
    let quiz_phrase_re =
        Regex::new(r"(?i)\b(true or false|select all|choose the)\b").unwrap();
    if quiz_phrase_re.is_match(text) {
        let truncated: String = text.chars().take(500).collect();
        return Some(truncated);
    }

    None
}

// ---------------------------------------------------------------------------
// OCR — macOS native implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn run_ocr(png_bytes: &[u8]) -> Result<String, String> {
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    unsafe {
        let data = NSData::with_bytes(png_bytes);

        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );

        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

        let requests = NSArray::from_retained_slice(&[request.clone()]);
        let requests: &NSArray<VNRequest> = requests.cast_unchecked();

        if let Err(err) = handler.performRequests_error(requests) {
            return Err(format!("OCR failed: {}", err.localizedDescription()));
        }

        if let Some(results) = request.results() {
            let mut texts = Vec::new();
            for i in 0..results.count() {
                let observation = results.objectAtIndex(i);
                let candidates = observation.topCandidates(1);
                if candidates.count() > 0 {
                    let candidate = candidates.objectAtIndex(0);
                    texts.push(candidate.string().to_string());
                }
            }
            Ok(texts.join("\n"))
        } else {
            Ok(String::new())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn run_ocr(_png_bytes: &[u8]) -> Result<String, String> {
    Err("OCR is only supported on macOS".to_string())
}

// ---------------------------------------------------------------------------
// Watch commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    window_id: u32,
    interval_ms: u64,
    hash_threshold: u32,
) -> Result<(), String> {
    // Setup: check if already running, create session
    {
        let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
        if let Some(ref session) = *guard {
            if session.is_running {
                return Err("Watch already running".to_string());
            }
        }
        let stop_flag = Arc::new(AtomicBool::new(false));
        *guard = Some(WatchSession {
            window_id,
            last_hash: None,
            last_question: None,
            is_running: true,
            stop_flag: stop_flag.clone(),
        });
    }

    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let state_clone = app_clone.state::<WatchState>();

        // Read stop_flag from state
        let stop_flag = {
            let guard = state_clone.lock().unwrap();
            guard.as_ref().unwrap().stop_flag.clone()
        };

        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;

            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            // Capture window screenshot on blocking thread
            let wid = window_id;
            let capture_result =
                tauri::async_runtime::spawn_blocking(move || {
                    let windows = xcap::Window::all()
                        .map_err(|e| format!("Failed to list windows: {e}"))?;

                    let window = windows
                        .into_iter()
                        .find(|w| w.id() == wid)
                        .ok_or_else(|| format!("Window with id {wid} not found"))?;

                    let rgba_image = window
                        .capture_image()
                        .map_err(|e| format!("Failed to capture window: {e}"))?;

                    let mut png_bytes: Vec<u8> = Vec::new();
                    rgba_image
                        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                        .map_err(|e| format!("Failed to encode PNG: {e}"))?;

                    Ok::<(Vec<u8>, image::RgbaImage), String>((png_bytes, rgba_image))
                })
                .await;

            let (png_bytes, rgba_image) = match capture_result {
                Ok(Ok(data)) => data,
                Ok(Err(e)) => {
                    let event = WatchEvent {
                        event_type: "error".to_string(),
                        question: None,
                        raw_text: Some(e),
                        timestamp_ms: current_timestamp_ms(),
                    };
                    let _ = app_clone.emit("watch_event", event);
                    break;
                }
                Err(e) => {
                    let event = WatchEvent {
                        event_type: "error".to_string(),
                        question: None,
                        raw_text: Some(format!("Task join error: {e}")),
                        timestamp_ms: current_timestamp_ms(),
                    };
                    let _ = app_clone.emit("watch_event", event);
                    break;
                }
            };

            // Compute perceptual hash and compare
            let new_hash = compute_hash(&rgba_image);

            let should_ocr = {
                let guard = state_clone.lock().unwrap();
                if let Some(ref session) = *guard {
                    match &session.last_hash {
                        Some(last) => last.dist(&new_hash) > hash_threshold,
                        None => true, // First capture, always process
                    }
                } else {
                    break; // Session was cleared
                }
            };

            if !should_ocr {
                continue;
            }

            // Run OCR
            let ocr_text = match run_ocr(&png_bytes) {
                Ok(text) => text,
                Err(_) => continue,
            };

            if ocr_text.trim().is_empty() {
                // Update hash even if no text
                let mut guard = state_clone.lock().unwrap();
                if let Some(ref mut session) = *guard {
                    session.last_hash = Some(new_hash);
                }
                continue;
            }

            // Detect question
            let question = detect_question(&ocr_text);

            if question.is_none() {
                // Update hash only, no question detected
                let mut guard = state_clone.lock().unwrap();
                if let Some(ref mut session) = *guard {
                    session.last_hash = Some(new_hash);
                }
                continue;
            }

            let question_text = question.unwrap();

            // Check if same as last question
            let is_duplicate = {
                let guard = state_clone.lock().unwrap();
                if let Some(ref session) = *guard {
                    session.last_question.as_deref() == Some(&question_text)
                } else {
                    false
                }
            };

            if is_duplicate {
                continue;
            }

            // Update state with new hash and question
            {
                let mut guard = state_clone.lock().unwrap();
                if let Some(ref mut session) = *guard {
                    session.last_hash = Some(new_hash);
                    session.last_question = Some(question_text.clone());
                }
            }

            // Emit question detected event
            let event = WatchEvent {
                event_type: "question_detected".to_string(),
                question: Some(question_text),
                raw_text: Some(ocr_text),
                timestamp_ms: current_timestamp_ms(),
            };
            let _ = app_clone.emit("watch_event", event);
        }

        // Mark session as not running when loop ends
        let mut guard = state_clone.lock().unwrap();
        if let Some(ref mut session) = *guard {
            session.is_running = false;
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ref mut session) = *guard {
        if session.is_running {
            session.stop_flag.store(true, Ordering::Relaxed);
            session.is_running = false;
        }
    }

    let event = WatchEvent {
        event_type: "watch_stopped".to_string(),
        question: None,
        raw_text: None,
        timestamp_ms: current_timestamp_ms(),
    };
    let _ = app.emit("watch_event", event);

    Ok(())
}

#[tauri::command]
fn get_watch_status(state: tauri::State<'_, WatchState>) -> WatchStatus {
    let guard = state.lock().unwrap();
    match *guard {
        Some(ref session) => WatchStatus {
            is_running: session.is_running,
            window_id: Some(session.window_id),
            last_question: session.last_question.clone(),
        },
        None => WatchStatus {
            is_running: false,
            window_id: None,
            last_question: None,
        },
    }
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

/// Lists all available windows with their metadata.
/// Filters out windows with empty titles and minimized windows.
#[tauri::command]
fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = xcap::Window::all().map_err(|e| format!("Failed to list windows: {e}"))?;

    Ok(windows
        .into_iter()
        .filter(|w| !w.title().is_empty() && !w.is_minimized())
        .map(|w| WindowInfo {
            id: w.id(),
            title: w.title().to_string(),
            app_name: w.app_name().to_string(),
            width: w.width(),
            height: w.height(),
            is_minimized: w.is_minimized(),
        })
        .collect())
}

/// Captures a screenshot of the specified window (by ID) and returns it as
/// a base64-encoded PNG.
#[tauri::command]
async fn capture_window_screenshot(window_id: u32) -> Result<Base64Image, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let windows =
            xcap::Window::all().map_err(|e| format!("Failed to list windows: {e}"))?;

        let window = windows
            .into_iter()
            .find(|w| w.id() == window_id)
            .ok_or_else(|| format!("Window with id {window_id} not found"))?;

        let rgba_image = window
            .capture_image()
            .map_err(|e| format!("Failed to capture window screenshot: {e}"))?;

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
        .manage(Mutex::new(None::<WatchSession>))
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
            list_windows,
            capture_window_screenshot,
            pick_image_file,
            start_watch,
            stop_watch,
            get_watch_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
