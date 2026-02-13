import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import type { ChatSession, ChatMessage } from "./lib/database.types";

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

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
  const loadSessions = async () => {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Failed to load sessions:", error.message);
      return;
    }

    setSessions(data ?? []);
  };

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

    setMessages((prev) => [...prev, data]);
    return data as ChatMessage;
  };

  // ── Render ─────────────────────────────────────────────────────────
  if (loading) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Login</h1>

        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <br />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <br />

        <button onClick={signIn}>Sign In</button>
        <button onClick={signUp}>Sign Up</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Chat</h1>

      <div style={{ marginBottom: 16 }}>
        <button onClick={() => createSession()}>New Chat</button>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ marginLeft: 8 }}
        >
          Sign Out
        </button>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        {/* Session list */}
        <div style={{ width: 200 }}>
          <h3>Sessions</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {sessions.map((session) => (
              <li
                key={session.id}
                style={{
                  padding: "8px",
                  cursor: "pointer",
                  background:
                    session.id === activeSessionId ? "#e0e0e0" : "transparent",
                  borderRadius: 4,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
                onClick={() => setActiveSessionId(session.id)}
              >
                <span>{session.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(session.id);
                  }}
                  style={{ fontSize: 12 }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Messages */}
        <div style={{ flex: 1 }}>
          {activeSessionId ? (
            <>
              <h3>Messages</h3>
              <div
                style={{
                  border: "1px solid #ccc",
                  borderRadius: 4,
                  padding: 12,
                  minHeight: 200,
                  maxHeight: 400,
                  overflowY: "auto",
                }}
              >
                {messages.length === 0 && (
                  <p style={{ color: "#999" }}>No messages yet.</p>
                )}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      marginBottom: 8,
                      textAlign: msg.role === "user" ? "right" : "left",
                    }}
                  >
                    <strong>{msg.role}:</strong> {msg.content}
                    {msg.image_url && (
                      <img
                        src={msg.image_url}
                        alt=""
                        style={{ maxWidth: 200, display: "block", marginTop: 4 }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ color: "#999" }}>
              Select a session or start a new chat.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;