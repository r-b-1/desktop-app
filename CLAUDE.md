# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Desktop note-taking app built with **React 19 + TypeScript** frontend, **Tauri 2 (Rust)** backend, and **Supabase** for auth and database.

## Commands

- `npm run dev` — Start Vite dev server (port 5173)
- `npm run build` — Type-check with `tsc -b` then bundle with Vite
- `npm run lint` — Run ESLint
- `npm run preview` — Preview production build
- `cargo tauri dev` — Run the full Tauri desktop app (auto-starts Vite dev server)
- `cargo tauri build` — Build the distributable desktop app

## Architecture

**Frontend** (`src/`):
- `main.tsx` — React entry point (StrictMode, mounts to `#root`)
- `App.tsx` — Single component handling auth (sign up/sign in/sign out) and notes CRUD
- `lib/supabase.ts` — Supabase client initialized from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` env vars

**Backend** (`src-tauri/`):
- Rust/Tauri 2 app wrapping the web frontend as a native desktop window
- `src/lib.rs` — Tauri builder setup with logging plugin
- `src/main.rs` — Entry point calling `app_lib::run()`
- `tauri.conf.json` — Tauri config (window size, dev URL, build commands)

**Data flow**: App.tsx calls Supabase JS SDK directly for auth and database operations. Chat data is stored in `chat_sessions` and `chat_messages` tables (the legacy `notes` table was migrated and archived). Auth state is tracked via `onAuthStateChange` subscription.

## Environment

Supabase credentials are in `.env` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Key Details

- TypeScript strict mode is enabled; unused variables/parameters are errors
- State management is component-level React hooks (no external state library)
- Styling uses CSS files (`index.css`, `App.css`) plus some inline styles
- Rust edition 2021, minimum Rust version 1.77.2
