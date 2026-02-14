# TODO

## Web Search Integration (OpenAI Responses API)

### Phase 1: API Migration
- [ ] Change API endpoint from `/v1/chat/completions` to `/v1/responses`
- [ ] Update `ChatCompletionOptions` type to include `tools` array
- [ ] Add `Tool` and `WebSearchTool` type definitions

### Phase 2: Request/Response Updates
- [ ] Modify request body: change `messages` → `input`
- [ ] Update `formatMessages()` function compatibility
- [ ] Add `tools` parameter to `streamChatCompletion()` options

### Phase 3: Streaming Parser Update
- [ ] Update SSE parser for new response format (`output` instead of `choices`)
- [ ] Handle `web_search_call` events
- [ ] Handle `output_text` delta events
- [ ] Extract citation annotations from responses

### Phase 4: UI Implementation
- [ ] Add web search toggle button in chat input area
- [ ] Show "Searching..." indicator when tool is called
- [ ] Render citation links in assistant messages
- [ ] Cache toggle state per session

### Phase 5: Testing
- [ ] Test with real-time queries (NBA scores, news)
- [ ] Verify citations render correctly
- [ ] Test streaming with tool calls
- [ ] Add error handling for failed searches

## Notes
- Cost: ~$0.03 per search request
- Model: gpt-4o-mini (already configured)
- API: Responses API required (not Chat Completions)
- Documentation: https://platform.openai.com/docs/guides/tools-web-search

---

# Watch Window & Answer Tool - Implementation Plan

## Overview
Building on the existing Tauri window capture + OpenAI infrastructure, add continuous monitoring with smart change detection and automatic question answering.

---

## Phase 1: Core Infrastructure (Backend - Rust)

### Dependencies to Add
```toml
# OCR - Native macOS Vision (recommended)
objc2-vision = "0.3"
objc2 = "0.6"

# OCR - Pure Rust alternative (cross-platform)
ocrs = "0.12"

# Change Detection
img_hash = "3.2"
image-compare = "0.5"

# Async utilities
tokio = { version = "1", features = ["time"] }
```

### Tasks
- [ ] Add new Rust commands: `start_watch`, `stop_watch`, `get_watch_status`, `capture_and_analyze`
- [ ] Implement `WatchSession` state struct with window_id, last_hash, last_ocr_text, is_running
- [ ] Build change detection module using perceptual hashing (pHash) via `img_hash`
  - Threshold: Hamming distance > 10-15 = significant change
  - Fallback: Pixel diff for small regions
- [ ] Implement OCR module using macOS Vision framework via `objc2-vision`
  - VNRecognizeTextRequest with accurate/fast mode
  - Alternative: `ocrs` for cross-platform
- [ ] Build question detection with regex patterns
  - Patterns: `/question|quiz|test|\?|Q\d+|:/i`
  - Heuristics: Short text ending with "?", numbered lists, bold text

---

## Phase 2: Frontend Integration (React/TypeScript)

### Components to Create
- [ ] `WatchControl.tsx` - Toggle button with status indicator
- [ ] `WatchOverlay.tsx` - Always-on-top answer display window
- [ ] `WatchSettings.tsx` - Sensitivity, interval, auto-answer configuration

### State Management
- [ ] Define `WatchState` interface with:
  - isWatching, targetWindow, lastCapture data
  - Settings: captureInterval (200-1000ms), changeThreshold (0-100), autoSendToAI, showOverlay

### Capture Loop
- [ ] Implement Rust async loop with Tauri events (recommended over frontend timer)
- [ ] Use Tauri `Channel` for streaming results from backend

---

## Phase 3: AI Integration

### Prompt Engineering
- [ ] Create `ANSWER_PROMPT` template for question answering
- [ ] Stream responses to overlay window

### Smart Triggering
Send to AI only when ALL conditions met:
- [ ] Visual change detected (hash diff)
- [ ] New text extracted from OCR
- [ ] Question pattern detected
- [ ] Not a duplicate of last question

---

## Phase 4: Answer Display

### Overlay Window
- [ ] Create Tauri window with `alwaysOnTop: true`
- [ ] Semi-transparent background styling
- [ ] Display: Question + Answer + Confidence score
- [ ] Auto-hide after timeout or manual dismiss

### Alternative Outputs
- [ ] Copy to clipboard option
- [ ] System native notifications
- [ ] Inline display in main chat window

---

## Phase 5: Optimization & Polish

### Performance
- [ ] Implement region of interest (ROI) cropping before OCR
- [ ] Adaptive capture rate (slower when no changes detected)
- [ ] Move background processing to Rust
- [ ] Cache recent screenshots

### Error Handling
- [ ] Handle window closed/minimized → pause watch
- [ ] OCR failures → retry with preprocessing (contrast, resize)
- [ ] LLM errors → fallback to cached responses

### Configuration
- [ ] Sensitivity slider (affects hash threshold)
- [ ] Question detection strictness setting
- [ ] AI model selection (fast vs accurate)

---

## Technical Decisions

### Q1: OCR Engine
- [x] **macOS Vision** - Native, fast, accurate, no extra dependencies
- [ ] ocrs - Pure Rust, cross-platform, slightly less accurate

### Q2: Loop Location
- [x] **Rust backend** - Better performance, works when frontend minimized
- [ ] Frontend - Easier debugging, more control

### Q3: Question Detection
- [x] **Simple regex** - Pattern matching for "?" and keywords
- [ ] Smart LLM classifier - Extra API cost
- [ ] Hybrid approach - Pattern matching → LLM confirmation

### Q4: Answer Display
- [x] **Floating overlay** - Always visible
- [ ] Chat message - Integrates with existing UI
- [ ] Both - Configurable

---

## Implementation Timeline

- **Week 1**: Backend - Change detection + OCR foundation
- **Week 2**: Backend - Watch loop + Tauri events
- **Week 3**: Frontend - Watch UI + overlay
- **Week 4**: Integration - AI pipeline + testing
- **Week 5**: Polish - Settings, error handling, optimization

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Backend (Rust)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Capture │→ │   Diff   │→ │   OCR    │→ │  Parser  │   │
│  │ (xcap)   │  │(img_hash)│  │(Vision)  │  │(regex)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └────┬─────┘   │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
┌──────────────────────────────────────────────────┼──────────┐
│              React Frontend (TypeScript)         │          │
│  ┌───────────────────────────────────────────────┘          │
│  │  Watch Controls ←──┐                                    │
│  │  Settings Panel    │                                    │
│  └────────────────────┼──────────────────────────────────┘ │
│                       ↓                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │  Overlay │  │  OpenAI  │  │   Chat   │                 │
│  │  Window  │  │   API    │  │   View   │                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
└────────────────────────────────────────────────────────────┘
```

---

## Notes
- Leverages existing `xcap` window capture infrastructure
- Reuses existing OpenAI streaming implementation
- Region selection overlay from screenshot feature can be adapted
- Pinned window state (`pinnedWindowId`) already exists in App.tsx
