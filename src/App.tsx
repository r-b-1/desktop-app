import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import type { ChatSession, ChatMessage } from "./lib/database.types";
import "./App.css";

// ── Helpers ─────────────────────────────────────────────────────────

/** Format a timestamp into a human-readable relative/absolute string. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// ── App ─────────────────────────────────────────────────────────────

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // UI state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Auth state ──────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Load sessions when user signs in ────────────────────────────────
  useEffect(() => {
    if (user) {
      loadSessions();
    } else {
      setSessions([]);
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [user]);

  // ── Load messages when active session changes ───────────────────────
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else {
      setMessages([]);
    }
  }, [activeSessionId]);

  // ── Auto-scroll messages ────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Focus title input when editing ──────────────────────────────────
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  // ── Auth helpers ────────────────────────────────────────────────────
  const signIn = async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) alert(error.message);
  };

  const signUp = async () => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
    });
    if (error) alert(error.message);
  };

  // ── Chat session CRUD ──────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from("chat_sessions")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Failed to load sessions:", error.message);
      return;
    }

    setSessions(data ?? []);
  }, [user]);

  const createSession = async (title = "New Chat") => {
    if (!user) return;

    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({ user_id: user.id, title })
      .select()
      .single();

    if (error) {
      console.error("Failed to create session:", error.message);
      return;
    }

    setSessions((prev) => [data, ...prev]);
    setActiveSessionId(data.id);
  };

  const renameSession = async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      setEditingSessionId(null);
      return;
    }

    const { error } = await supabase
      .from("chat_sessions")
      .update({ title: trimmed })
      .eq("id", sessionId);

    if (error) {
      console.error("Failed to rename session:", error.message);
      return;
    }

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s))
    );
    setEditingSessionId(null);
  };

  const deleteSession = async (sessionId: string) => {
    const { error } = await supabase
      .from("chat_sessions")
      .delete()
      .eq("id", sessionId);

    if (error) {
      console.error("Failed to delete session:", error.message);
      return;
    }

    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
    }
    setDeletingSessionId(null);
  };

  // ── Chat message CRUD ──────────────────────────────────────────────
  const loadMessages = async (sessionId: string) => {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Failed to load messages:", error.message);
      return;
    }

    setMessages(data ?? []);
  };

  // Keep addMessage for future use when message input is implemented
  const _addMessage = async (
    sessionId: string,
    role: ChatMessage["role"],
    content: string,
    imageUrl?: string
  ) => {
    const { data, error } = await supabase
      .from("chat_messages")
      .insert({
        session_id: sessionId,
        role,
        content,
        image_url: imageUrl ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to add message:", error.message);
      return null;
    }

    setMessages((prev) => [...prev, data]);
    return data as ChatMessage;
  };

  // Suppress unused warning — will be wired up when chat input is built
  void _addMessage;

  // ── Derived state ──────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // ── Render: Loading ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        Loading...
      </div>
    );
  }

  // ── Render: Login ───────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>Welcome</h1>
          <p className="login-subtitle">Sign in to access your chats</p>

          <div className="login-form">
            <input
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && signIn()}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && signIn()}
            />
            <div className="login-actions">
              <button className="btn-primary" onClick={signIn}>
                Sign In
              </button>
              <button className="btn-secondary" onClick={signUp}>
                Sign Up
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Main app ────────────────────────────────────────────────
  return (
    <div className="app-layout">
      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
            <span className="sidebar-title">Chats</span>
          </div>
          <button className="btn-new-chat" onClick={() => createSession()}>
            + New Chat
          </button>
        </div>

        {/* Session list */}
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="session-list-empty">
              No conversations yet.
              <br />
              Start a new chat to begin.
            </div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${
                  session.id === activeSessionId ? "active" : ""
                }`}
                onClick={() => setActiveSessionId(session.id)}
              >
                <div className="session-item-content">
                  {editingSessionId === session.id ? (
                    <input
                      ref={editInputRef}
                      className="session-title-input"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => renameSession(session.id, editingTitle)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          renameSession(session.id, editingTitle);
                        } else if (e.key === "Escape") {
                          setEditingSessionId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="session-item-title">{session.title}</span>
                  )}
                  <span className="session-item-time">
                    {formatTime(session.updated_at)}
                  </span>
                </div>

                <div className="session-item-actions">
                  {/* Rename button */}
                  <button
                    className="btn-session-action"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSessionId(session.id);
                      setEditingTitle(session.title);
                    }}
                  >
                    ✎
                  </button>

                  {/* Delete button */}
                  <button
                    className="btn-session-action delete"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingSessionId(session.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="sidebar-footer">
          <span className="user-info" title={user.email}>
            {user.email}
          </span>
          <button
            className="btn-sign-out"
            onClick={() => supabase.auth.signOut()}
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="main-content">
        {activeSession ? (
          <>
            <div className="chat-header">
              <h2>{activeSession.title}</h2>
              <span className="chat-header-time">
                Created {formatTime(activeSession.created_at)}
              </span>
            </div>

            <div className="messages-container">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">💬</div>
                  <p>No messages yet</p>
                  <span className="hint">
                    This chat session is ready for messages.
                  </span>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message-bubble ${msg.role}`}
                  >
                    <div className="message-role">{msg.role}</div>
                    {msg.content}
                    {msg.image_url && (
                      <img
                        src={msg.image_url}
                        alt=""
                        className="message-image"
                      />
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <p>Select a conversation or start a new chat</p>
            <span className="hint">
              Your chat sessions appear in the sidebar
            </span>
          </div>
        )}
      </main>

      {/* ── Delete confirmation dialog ───────────────────────────────── */}
      {deletingSessionId && (
        <div
          className="confirm-overlay"
          onClick={() => setDeletingSessionId(null)}
        >
          <div
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <p>
              Delete this chat session? All messages in it will be permanently
              removed.
            </p>
            <div className="confirm-dialog-actions">
              <button
                className="btn-secondary"
                onClick={() => setDeletingSessionId(null)}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => deleteSession(deletingSessionId)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
