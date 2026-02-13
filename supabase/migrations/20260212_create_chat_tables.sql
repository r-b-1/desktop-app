-- Migration: Replace notes table with chat_sessions and chat_messages tables
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)
--
-- This migration safely archives existing notes data, creates the new chat
-- tables, backfills legacy notes into the new schema, and only drops the
-- original table after a successful backfill. The entire operation runs in a
-- single transaction so partial data-loss is impossible.

BEGIN;

-- =============================================================================
-- 1. Archive existing notes to a backup table (if the table exists)
-- =============================================================================
-- We use a DO block so the migration is idempotent: if `notes` does not exist
-- the block is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notes'
  ) THEN
    -- Create a timestamped backup so the archive is never accidentally overwritten
    EXECUTE 'CREATE TABLE IF NOT EXISTS notes_backup_' || to_char(now(), 'YYYYMMDD_HH24MISS') ||
            ' AS TABLE notes';

    -- Also keep a stable alias that later tooling can reference
    CREATE TABLE IF NOT EXISTS notes_archive AS TABLE notes;
  END IF;
END
$$;

-- =============================================================================
-- 2. Create chat_sessions table
-- =============================================================================
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);

-- Auto-update the updated_at timestamp on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER trg_chat_sessions_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 3. Create chat_messages table
-- =============================================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  image_url  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast message retrieval by session
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);

-- Composite index for ordering messages within a session
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at);

-- =============================================================================
-- 4. Backfill: migrate legacy notes into the new chat tables
-- =============================================================================
-- Each note becomes one chat_session (title derived from the note title) with a
-- single chat_message of role 'user' holding the note content.
-- The backfill is skipped when the notes table does not exist or is empty.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notes'
  ) THEN
    -- Insert a chat_session per note, preserving the original id & timestamps
    -- when the columns exist. We detect available columns dynamically so this
    -- migration works regardless of the exact notes schema.

    -- Attempt the most complete mapping first (id, user_id, title, created_at).
    -- Fall back gracefully when columns are missing.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'title'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'user_id'
    ) THEN
      -- Full mapping: notes has title and user_id
      INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
      SELECT
        n.id,
        n.user_id,
        COALESCE(n.title, 'Imported Note'),
        COALESCE(n.created_at, now()),
        COALESCE(n.created_at, now())
      FROM notes n
      ON CONFLICT (id) DO NOTHING;

      -- Migrate note body into a single 'user' message per session
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'content'
      ) THEN
        INSERT INTO chat_messages (session_id, role, content, created_at)
        SELECT
          n.id,
          'user',
          n.content,
          COALESCE(n.created_at, now())
        FROM notes n
        WHERE n.content IS NOT NULL AND n.content <> ''
        ON CONFLICT DO NOTHING;
      END IF;

    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'user_id'
    ) THEN
      -- notes has user_id but no title column
      INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
      SELECT
        n.id,
        n.user_id,
        'Imported Note',
        COALESCE(n.created_at, now()),
        COALESCE(n.created_at, now())
      FROM notes n
      ON CONFLICT (id) DO NOTHING;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'content'
      ) THEN
        INSERT INTO chat_messages (session_id, role, content, created_at)
        SELECT
          n.id,
          'user',
          n.content,
          COALESCE(n.created_at, now())
        FROM notes n
        WHERE n.content IS NOT NULL AND n.content <> ''
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    RAISE NOTICE 'notes backfill complete – archived to notes_archive';
  ELSE
    RAISE NOTICE 'notes table does not exist – nothing to migrate';
  END IF;
END
$$;

-- =============================================================================
-- 5. Drop the original notes table only after successful backfill
-- =============================================================================
-- At this point the data is safely in notes_archive AND in the new chat tables.
DROP TABLE IF EXISTS notes;

-- =============================================================================
-- 6. Enable Row Level Security (RLS)
-- =============================================================================
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 7. RLS Policies for chat_sessions
-- =============================================================================

-- Users can only view their own sessions
CREATE POLICY "Users can view own sessions"
  ON chat_sessions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can only create sessions for themselves
CREATE POLICY "Users can create own sessions"
  ON chat_sessions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only update their own sessions
CREATE POLICY "Users can update own sessions"
  ON chat_sessions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can only delete their own sessions
CREATE POLICY "Users can delete own sessions"
  ON chat_sessions
  FOR DELETE
  USING (auth.uid() = user_id);

-- =============================================================================
-- 8. RLS Policies for chat_messages
-- =============================================================================
-- Messages are scoped through their parent session's user_id

-- Users can view messages in their own sessions
CREATE POLICY "Users can view own messages"
  ON chat_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  );

-- Users can insert messages into their own sessions
CREATE POLICY "Users can create messages in own sessions"
  ON chat_messages
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  );

-- Users can update messages in their own sessions
CREATE POLICY "Users can update own messages"
  ON chat_messages
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  );

-- Users can delete messages in their own sessions
CREATE POLICY "Users can delete own messages"
  ON chat_messages
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  );

COMMIT;
