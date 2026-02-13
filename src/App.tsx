import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { ChatSession, ChatMessage } from "./lib/database.types";
import { streamChatCompletion } from "./lib/openai";
import "./App.css";

// ── Types ───────────────────────────────────────────────────────────

/** Shape returned by our Tauri screenshot / file-picker commands. */
interface Base64Image {
  data: string;
  mime_type: string;
}

/** A pending image attachment before the message is sent. */
interface PendingImage {
  id: string;
  base64: string;
  mimeType: string;
  preview: string; // data-URL for display
}

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

/** Convert a base64 string + MIME type into a data-URL for preview. */
function toDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Generate a unique id for pending image tracking. */
let _imgCounter = 0;
function nextImageId(): string {
  return `img-${Date.now()}-${++_imgCounter}`;
}

// ── Supabase Storage helpers ────────────────────────────────────────

const STORAGE_BUCKET = "chat-images";

/** Upload a base64-encoded image to Supabase Storage and return its public URL. */
async function uploadImageToStorage(
  base64: string,
  mimeType: string,
  userId: string
): Promise<string> {
  // Convert base64 to Uint8Array
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const filePath = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, bytes, { contentType: mimeType, upsert: false });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

// ── OpenAI configuration ────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a helpful, knowledgeable assistant. Be concise and informative in your responses.";

// ── App ─────────────────────────────────────────────────────────────

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Chat input state
  const [messageInput, setMessageInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");

  // UI state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [imageModalUrl, setImageModalUrl] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref mirrors activeSessionId so async closures always see the latest value
  const activeSessionIdRef = useRef<string | null>(null);
  // Tracks which session the in-flight send belongs to
  const sendingSessionIdRef = useRef<string | null>(null);

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
  }, [user, loadSessions]);

  // ── Keep activeSessionIdRef in sync with state ─────────────────────
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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
  }, [messages, sending, streamingContent]);

  // ── Focus title input when editing ──────────────────────────────────
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  // ── Focus chat input when active session changes ────────────────────
  useEffect(() => {
    if (activeSessionId) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeSessionId]);

  const createSession = async (title = "New Chat") => {
    if (!user) return null;

    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({ user_id: user.id, title })
      .select()
      .single();

    if (error) {
      console.error("Failed to create session:", error.message);
      return null;
    }

    setSessions((prev) => [data, ...prev]);
    setActiveSessionId(data.id);
    return data as ChatSession;
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

  const addMessage = async (
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

    // Only update local message state if the message belongs to the
    // currently active session; otherwise it will be loaded when the
    // user navigates back to that session.
    if (sessionId === activeSessionIdRef.current) {
      setMessages((prev) => [...prev, data]);
    }

    // Touch session updated_at
    await supabase
      .from("chat_sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", sessionId);

    return data as ChatMessage;
  };

  // ── Image attachment handlers ─────────────────────────────────────

  const handleScreenshot = async () => {
    try {
      const result = await invoke<Base64Image>("capture_monitor_screenshot", {
        monitor_index: null,
      });
      setPendingImages((prev) => [
        ...prev,
        {
          id: nextImageId(),
          base64: result.data,
          mimeType: result.mime_type,
          preview: toDataUrl(result.data, result.mime_type),
        },
      ]);
    } catch (err) {
      console.error("Screenshot failed:", err);
    }
  };

  const handleImageUpload = async () => {
    try {
      const result = await invoke<Base64Image | null>("pick_image_file");
      if (!result) return; // user cancelled
      setPendingImages((prev) => [
        ...prev,
        {
          id: nextImageId(),
          base64: result.data,
          mimeType: result.mime_type,
          preview: toDataUrl(result.data, result.mime_type),
        },
      ]);
    } catch (err) {
      console.error("Image upload failed:", err);
    }
  };

  const removePendingImage = (id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  };

  // ── Send message ──────────────────────────────────────────────────

  const sendMessage = async () => {
    const text = messageInput.trim();
    if (!text && pendingImages.length === 0) return;
    if (sending) return;

    setSending(true);
    setStreamingContent("");

    try {
      // If no active session, create one (title from first message)
      let sessionId = activeSessionId;
      if (!sessionId) {
        const title = text.slice(0, 50) || "New Chat";
        const newSession = await createSession(title);
        if (!newSession) {
          setSending(false);
          return;
        }
        sessionId = newSession.id;
      }

      // Upload all pending images and send each as its own message.
      // The first image is attached to the user's text message; additional
      // images are sent as separate user messages so no attachment is lost.
      const imagesToSend = [...pendingImages];
      const sentImageIds: string[] = [];
      const additionalImageUrls: (string | undefined)[] = [];

      // Upload the first image (attached to the main text message)
      let firstImageUrl: string | undefined;
      if (imagesToSend.length > 0 && user) {
        const img = imagesToSend[0];
        try {
          firstImageUrl = await uploadImageToStorage(
            img.base64,
            img.mimeType,
            user.id
          );
          sentImageIds.push(img.id);
        } catch (err) {
          console.error("Image upload to storage failed:", err);
          // Fall back to data URL so the image is still visible
          firstImageUrl = img.preview;
          sentImageIds.push(img.id);
        }
      }

      // Insert the primary user message (text + optional first image)
      const userMsg = await addMessage(sessionId, "user", text, firstImageUrl);
      if (!userMsg) {
        // Clear only successfully sent images so the rest remain pending
        setPendingImages((prev) =>
          prev.filter((img) => !sentImageIds.includes(img.id))
        );
        setSending(false);
        return;
      }

      // Send remaining images as individual messages
      if (user) {
        for (let i = 1; i < imagesToSend.length; i++) {
          const img = imagesToSend[i];
          let imageUrl: string | undefined;
          try {
            imageUrl = await uploadImageToStorage(
              img.base64,
              img.mimeType,
              user.id
            );
          } catch (err) {
            console.error("Image upload to storage failed:", err);
            imageUrl = img.preview;
          }

          const msg = await addMessage(sessionId, "user", "", imageUrl);
          if (msg) {
            sentImageIds.push(img.id);
            additionalImageUrls.push(imageUrl);
          } else {
            // Stop sending further images on failure; keep unsent ones pending
            break;
          }
        }
      }

      // Clear input and only remove successfully sent images
      setMessageInput("");
      setPendingImages((prev) =>
        prev.filter((img) => !sentImageIds.includes(img.id))
      );

      // Pin the session ID for this in-flight request so the streaming
      // indicator and token updates are scoped to the correct session.
      sendingSessionIdRef.current = sessionId;

      // Build conversation context for OpenAI from existing messages
      // plus the ones we just sent (state hasn't re-rendered yet)
      const contextMessages: Array<{
        role: string;
        content: string;
        image_url?: string | null;
      }> = [
        ...messages.map((m) => ({
          role: m.role,
          content: m.content,
          image_url: m.image_url,
        })),
        // Primary user message sent above
        { role: "user", content: text, image_url: firstImageUrl ?? null },
        // Any additional image-only messages
        ...additionalImageUrls.map((url) => ({
          role: "user" as const,
          content: "",
          image_url: url ?? null,
        })),
      ];

      // Stream AI response from OpenAI
      let aiResponseText = "";

      await streamChatCompletion(
        contextMessages,
        {
          onToken: (token) => {
            // Only push streaming tokens to the UI when the user is still
            // viewing the session that originated this request.
            if (activeSessionIdRef.current === sendingSessionIdRef.current) {
              setStreamingContent((prev) => prev + token);
            }
          },
          onComplete: (fullText) => {
            aiResponseText = fullText;
          },
          onError: (error) => {
            console.error("OpenAI streaming error:", error.message);
            aiResponseText = `Sorry, I wasn't able to respond — ${error.message}`;
          },
        },
        { systemPrompt: SYSTEM_PROMPT }
      );

      // Save the AI response to Supabase (updates session timestamp too)
      if (aiResponseText) {
        await addMessage(sessionId, "assistant", aiResponseText);
      }

      // Refresh session list to update timestamps
      loadSessions();
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
      setStreamingContent("");
      sendingSessionIdRef.current = null;
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

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

            {/* ── Message list ──────────────────────────────────────── */}
            <div className="messages-container">
              {messages.length === 0 && !sending ? (
                <div className="empty-state">
                  <div className="empty-state-icon">💬</div>
                  <p>No messages yet</p>
                  <span className="hint">
                    Type a message below to start the conversation.
                  </span>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`message-bubble ${msg.role}`}
                    >
                      <div className="message-role">
                        {msg.role === "user" ? "You" : msg.role}
                      </div>
                      {msg.content && (
                        <div className="message-text">{msg.content}</div>
                      )}
                      {msg.image_url && (
                        <img
                          src={msg.image_url}
                          alt="Attached image"
                          className="message-image"
                          onClick={() => setImageModalUrl(msg.image_url)}
                        />
                      )}
                      <div className="message-time">
                        {formatTime(msg.created_at)}
                      </div>
                    </div>
                  ))}

                  {/* Streaming response / typing indicator — only show
                      when the active session is the one being streamed into */}
                  {sending && activeSessionId === sendingSessionIdRef.current && (
                    <div className="message-bubble assistant">
                      <div className="message-role">assistant</div>
                      {streamingContent ? (
                        <div className="message-text">{streamingContent}</div>
                      ) : (
                        <div className="typing-indicator">
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Chat input bar ────────────────────────────────────── */}
            <div className="chat-input-bar">
              {/* Pending image previews */}
              {pendingImages.length > 0 && (
                <div className="pending-images">
                  {pendingImages.map((img) => (
                    <div key={img.id} className="pending-image-thumb">
                      <img src={img.preview} alt="Pending attachment" />
                      <button
                        className="pending-image-remove"
                        onClick={() => removePendingImage(img.id)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="chat-input-row">
                {/* Attachment buttons */}
                <div className="chat-input-actions">
                  <button
                    className="btn-input-action"
                    title="Take screenshot"
                    onClick={handleScreenshot}
                    disabled={sending}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </button>
                  <button
                    className="btn-input-action"
                    title="Upload image"
                    onClick={handleImageUpload}
                    disabled={sending}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </button>
                </div>

                {/* Text input */}
                <textarea
                  ref={inputRef}
                  className="chat-textarea"
                  placeholder="Type a message..."
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  disabled={sending}
                  rows={1}
                />

                {/* Send button */}
                <button
                  className="btn-send"
                  onClick={sendMessage}
                  disabled={
                    sending ||
                    (!messageInput.trim() && pendingImages.length === 0)
                  }
                  title="Send message"
                >
                  {sending ? (
                    <div className="loading-spinner small" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  )}
                </button>
              </div>
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

      {/* ── Image lightbox modal ─────────────────────────────────────── */}
      {imageModalUrl && (
        <div
          className="confirm-overlay"
          onClick={() => setImageModalUrl(null)}
        >
          <div className="image-modal" onClick={(e) => e.stopPropagation()}>
            <img src={imageModalUrl} alt="Full size" />
            <button
              className="image-modal-close"
              onClick={() => setImageModalUrl(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

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
