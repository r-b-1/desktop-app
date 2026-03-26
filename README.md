# AI Desktop Chat

A native macOS desktop application that combines a persistent AI chat interface with real-time screen intelligence — built with Tauri (Rust), React 19, and TypeScript.

## Overview

AI Desktop Chat is a full-stack desktop app that goes beyond a simple chat window. It can watch any window on your screen, detect when a question appears using on-device OCR, and automatically dispatch it to GPT-4o mini for an answer — all in under a second. It supports multi-modal conversations with images, streaming responses, live web search, and a fully themeable UI.

## Features

### AI Chat
- Persistent multi-session conversations backed by Supabase (PostgreSQL)
- Real-time streaming responses via the OpenAI Responses API (SSE)
- Optional live web search with inline URL citations rendered per message
- Full chat history: create, rename, and delete sessions from the sidebar

### Vision & Screenshot Analysis
- Capture the full screen, a specific application window, or an interactive drag-to-select region
- Attach images from disk via file picker
- Images are automatically downsampled to 1024px before sending to reduce latency and cost
- Four specialized analysis modes with tailored system prompts:
  - **General** — answers questions, picks from multiple-choice options
  - **Sports** — uses web search targeting ESPN, StatMuse, Basketball Reference
  - **Code** — analyzes code, explains logic, identifies bugs
  - **Quiz** — strict multiple-choice adherence with brief explanations

### Window Watch Mode
A Rust background loop (running off the main thread via Tokio) monitors a pinned application window:
1. Captures a screenshot at a configurable interval (default 400 ms)
2. Computes a perceptual hash (pHash) and skips the frame if the image hasn't changed beyond a configurable threshold
3. Runs macOS Vision framework OCR on changed frames to extract text
4. Detects question patterns in the extracted text
5. Emits a Tauri event to the frontend, which auto-sends the detected question to GPT-4o mini

Settings (interval, hash threshold, auto-send toggle) are persisted to localStorage and exposed in the UI.

### Theming
- Dark, light, and system-follow modes controlled via a `data-theme` attribute on `<html>`
- Eight accent color presets (Copper, Rose, Gold, Ocean, Violet, etc.) plus a free-form color picker
- Accent selection dynamically generates a full set of CSS custom properties (base, hover, text, soft, glow variants) from a single hex value
- All preferences persisted to localStorage and restored on launch

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | Tauri 2 (Rust) |
| Frontend framework | React 19 + TypeScript (strict mode) |
| Bundler | Vite |
| Auth & database | Supabase (PostgreSQL + Storage) |
| AI | OpenAI GPT-4o mini via Responses API |
| Async Rust | Tokio |
| Screen capture | macOS CoreGraphics via Tauri commands |
| OCR | macOS Vision framework (via objc2 bindings) |
| Perceptual hashing | img\_hash crate |
| Styling | Custom CSS design system ("Warm Noir") |

## Architecture

```
desktop-app/
├── src/                         # React + TypeScript frontend
│   ├── App.tsx                  # Root component — all state, all features
│   ├── lib/
│   │   ├── openai.ts            # Responses API client (streaming, retry, web search)
│   │   ├── supabase.ts          # Supabase client
│   │   └── database.types.ts    # ChatSession / ChatMessage types
│   └── components/
│       └── WatchControl.tsx     # Watch mode status + start/stop controls
└── src-tauri/                   # Rust / Tauri backend
    ├── Cargo.toml
    └── src/
        ├── main.rs              # Entry point
        └── lib.rs               # Tauri commands: screenshot, window list,
                                 #   region capture, watch loop (OCR + pHash)
```

**Data flow:**
- The React frontend calls Supabase directly for auth and chat persistence
- Screenshot/OCR/watch operations are Tauri `invoke` calls to Rust commands
- The Rust watch loop emits `watch_event` Tauri events; the frontend listens and reacts
- Images are uploaded to Supabase Storage and passed as base64 data-URLs to the OpenAI API

## Development

```bash
# Prerequisites: Node.js, Rust, Tauri CLI

cp .env.example .env
# Fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_OPENAI_API_KEY

npm install

# Run the full desktop app (starts Vite dev server automatically)
cargo tauri dev

# Frontend only
npm run dev

# Type-check + build
npm run build

# Lint
npm run lint

# Distributable binary
cargo tauri build
```

## GitHub Beta Releases

Pushing a tag that starts with `v` will trigger the GitHub Actions beta release workflow and attach:
- a macOS `.dmg`
- a Windows `.exe` installer (NSIS)

Example:

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

The workflow creates a draft prerelease on GitHub so you can review it before publishing.

## Environment Variables

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `VITE_OPENAI_API_KEY` | OpenAI API key |

## Key Engineering Details

- **TypeScript strict mode** — no implicit `any`, unused variables are compile errors
- **Streaming with backpressure** — SSE reader processes chunks incrementally; partial lines are buffered across reads
- **Retry with exponential backoff + jitter** — retries rate-limit (429) and server (5xx) errors up to 3 times (1 s → 2 s → 4 s), with 10% jitter to avoid thundering herd
- **Perceptual hashing** — pHash comparison avoids redundant OCR on static frames, keeping CPU usage low during watch sessions
- **Ref/state synchronization** — long-running async closures (watch loop listener, live refresh) read from refs rather than stale closure captures
- **Image optimization** — screenshots are canvas-downsampled on the frontend before API submission, cutting token cost and round-trip time
