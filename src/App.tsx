import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { ChatSession, ChatMessage } from "./lib/database.types";
import { streamChatCompletion } from "./lib/openai";
import type { UrlCitation } from "./lib/openai";
import "./App.css";

// ── Types ───────────────────────────────────────────────────────────

/** Shape returned by our Tauri screenshot / file-picker commands. */
interface Base64Image {
  data: string;
  mime_type: string;
}

/** Shape returned by the list_windows Tauri command. */
interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  width: number;
  height: number;
  is_minimized: boolean;
}

/** A pending image attachment before the message is sent. */
interface PendingImage {
  id: string;
  base64: string;
  mimeType: string;
  preview: string; // data-URL for display
}

// ── Theme / accent types ────────────────────────────────────────────

type ThemeMode = "dark" | "light" | "system";

interface AccentPreset {
  name: string;
  color: string;
}

const ACCENT_PRESETS: AccentPreset[] = [
  { name: "Copper", color: "#d4874d" },
  { name: "Rose", color: "#c97b7b" },
  { name: "Crimson", color: "#c94d4d" },
  { name: "Gold", color: "#c9a84d" },
  { name: "Sage", color: "#6b9e6b" },
  { name: "Ocean", color: "#5b8a9e" },
  { name: "Violet", color: "#8b7bc9" },
  { name: "Slate", color: "#7b8a9e" },
];

/** Derive accent-related CSS custom properties from a single hex color. */
function buildAccentVars(hex: string) {
  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Darken for hover (dark theme)
  const darken = (v: number, amt: number) => Math.max(0, Math.round(v * (1 - amt)));
  // Lighten for text (dark theme)
  const lighten = (v: number, amt: number) => Math.min(255, Math.round(v + (255 - v) * amt));

  return {
    "--accent-base": hex,
    "--accent-rgb": `${r}, ${g}, ${b}`,
    "--accent-hover-dark": `rgb(${darken(r, 0.08)}, ${darken(g, 0.08)}, ${darken(b, 0.08)})`,
    "--accent-text-dark": `rgb(${lighten(r, 0.15)}, ${lighten(g, 0.15)}, ${lighten(b, 0.15)})`,
    "--accent-base-light": `rgb(${darken(r, 0.15)}, ${darken(g, 0.15)}, ${darken(b, 0.15)})`,
    "--accent-hover-light": `rgb(${darken(r, 0.22)}, ${darken(g, 0.22)}, ${darken(b, 0.22)})`,
    "--accent-text-light": `rgb(${darken(r, 0.28)}, ${darken(g, 0.28)}, ${darken(b, 0.28)})`,
    "--accent-soft-val": `rgba(${r}, ${g}, ${b}, 0.12)`,
    "--accent-softer-val": `rgba(${r}, ${g}, ${b}, 0.06)`,
    "--accent-glow-val": `0 0 24px rgba(${r}, ${g}, ${b}, 0.12)`,
  };
}

// ── Analysis mode types ─────────────────────────────────────────────

type AnalysisMode = "general" | "sports" | "code" | "quiz";

interface AnalysisModeConfig {
  label: string;
  userMessage: string;
  systemPrompt: string;
  webSearch: boolean;
  maxTokens: number;
}

const ANALYSIS_MODES: Record<AnalysisMode, AnalysisModeConfig> = {
  general: {
    label: "General",
    userMessage: "Look at this screenshot. If there is a question or problem, answer it. If there are answer choices listed, you MUST pick from those choices only.",
    systemPrompt:
      "You are a helpful assistant. ANSWER any question, problem, or assignment shown in the screenshot directly — do not just describe or restate it. If answer choices are provided (A, B, C, D, etc.), you MUST select from those options only — never invent your own answer. If you need current information, use web search. Only describe the image if there is truly nothing to answer.",
    webSearch: true,
    maxTokens: 1024,
  },
  sports: {
    label: "Sports",
    userMessage: "Answer this sports question. If answer choices are listed, pick from those choices only.",
    systemPrompt:
      "You are a sports expert. Answer the sports question in this screenshot. If multiple choice options are provided, you MUST choose from the listed options only. ALWAYS use web search — prefer searching ESPN (espn.com), StatMuse (statmuse.com), Basketball Reference (basketball-reference.com), and other sports-reference.com sites for accurate stats, scores, records, and standings. Give the answer first, then a brief explanation with the source.",
    webSearch: true,
    maxTokens: 1024,
  },
  code: {
    label: "Code",
    userMessage: "Analyze this code or answer this programming question.",
    systemPrompt:
      "You are a programming expert. Analyze the code shown, identify bugs, explain logic, or answer the programming question. If answer choices are provided, select from those only. Be concise and technical.",
    webSearch: false,
    maxTokens: 1024,
  },
  quiz: {
    label: "Quiz",
    userMessage: "Answer this question. If answer choices are listed (A, B, C, D, etc.), you MUST pick from those choices only.",
    systemPrompt:
      "You are answering a quiz or test question. Read the question and ALL answer choices carefully. You MUST select from the provided options — NEVER make up an answer that is not listed. State the correct letter/option first, then give a short explanation. Use web search if you need current information.",
    webSearch: true,
    maxTokens: 1024,
  },
};

/**
 * Downsize a base64 image to a max dimension for faster API processing.
 * Returns the original if already small enough.
 */
function downsizeImageBase64(
  base64: string,
  mimeType: string,
  maxDim = 1024
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (width <= maxDim && height <= maxDim) {
        resolve(base64);
        return;
      }
      const scale = maxDim / Math.max(width, height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL(mimeType, 0.85);
      resolve(dataUrl.split(",")[1]);
    };
    img.onerror = () => resolve(base64);
    img.src = `data:${mimeType};base64,${base64}`;
  });
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
  "You are GPT-4o mini, a helpful and knowledgeable AI assistant. Be concise and informative in your responses. When asked about your identity, identify yourself as GPT-4o mini.";

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
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // UI state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [imageModalUrl, setImageModalUrl] = useState<string | null>(null);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Theme & accent preferences (persisted to localStorage)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem("theme-mode") as ThemeMode) || "dark";
  });
  const [accentColor, setAccentColor] = useState(() => {
    return localStorage.getItem("accent-color") || "#d4874d";
  });

  // Screenshot mode state
  const [screenshotMode, setScreenshotMode] = useState<"screen" | "window">("screen");
  const [pinnedWindowId, setPinnedWindowId] = useState<number | null>(null);
  const [pinnedWindowTitle, setPinnedWindowTitle] = useState<string | null>(null);
  const [showWindowPicker, setShowWindowPicker] = useState(false);
  const [windowList, setWindowList] = useState<WindowInfo[]>([]);
  const [screenshotModeMenuOpen, setScreenshotModeMenuOpen] = useState(false);

  // Region capture state
  const [regionCaptureScreenshot, setRegionCaptureScreenshot] = useState<string | null>(null);
  const [regionSelection, setRegionSelection] = useState({ x: 0, y: 0, width: 400, height: 300 });
  const [regionDragState, setRegionDragState] = useState<{
    type: "move" | "resize";
    handle?: string;
    startMouseX: number;
    startMouseY: number;
    startSelection: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [captureFlashKey, setCaptureFlashKey] = useState(0);

  // Instant analysis state
  const [instantAnalysisEnabled, setInstantAnalysisEnabled] = useState(() => {
    return localStorage.getItem("instant-analysis") === "true";
  });
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(() => {
    return (localStorage.getItem("analysis-mode") as AnalysisMode) || "general";
  });
  const [analysisStreamingContent, setAnalysisStreamingContent] = useState("");
  const [analysisComplete, setAnalysisComplete] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAnalysisSearching, setIsAnalysisSearching] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const regionOverlayRef = useRef<HTMLDivElement>(null);
  const regionImageRef = useRef<HTMLImageElement>(null);
  const regionInitializedRef = useRef(false);
  const regionDragStateRef = useRef(regionDragState);

  // Signals the live-refresh loop to stop immediately (avoids race with React render cycle)
  const liveRefreshStoppedRef = useRef(false);

  // Instant analysis refs
  const instantAnalysisEnabledRef = useRef(false);
  const analysisCompleteRef = useRef<string | null>(null);
  const analysisImageRef = useRef<PendingImage | null>(null);
  const performInstantAnalysisRef = useRef<((image: PendingImage) => Promise<void>) | null>(null);
  const analysisGenRef = useRef(0);

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

  // ── Keep refs in sync with state ────────────────────────────────────
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    regionDragStateRef.current = regionDragState;
  }, [regionDragState]);

  // ── Load messages when active session changes ───────────────────────
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId).then(() => {
        // Force scroll to the newest messages after history loads.
        // setTimeout ensures the DOM has updated with the new messages
        // before we attempt to scroll.
        setTimeout(() => scrollToBottom(true), 0);
      });
    } else {
      setMessages([]);
    }
  }, [activeSessionId]);

  // ── Auto-scroll messages ────────────────────────────────────────────

  /**
   * Scroll the messages container to the bottom.
   * When `force` is true the scroll happens unconditionally (used after
   * loading a session's history so the user sees the newest messages).
   * Without `force`, the scroll is only performed when the user is
   * already near the bottom (within 150 px) to avoid yanking them away
   * from older content they are reading.
   */
  const scrollToBottom = useCallback((force?: boolean) => {
    const container = messagesContainerRef.current;
    if (!container) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (force) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
    if (isNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  // Scroll (non-forced) when messages change or streaming content updates.
  useEffect(() => {
    scrollToBottom();
  }, [messages, sending, streamingContent, scrollToBottom]);

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

  // ── Apply theme mode to <html> ──────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
    localStorage.setItem("theme-mode", themeMode);
  }, [themeMode]);

  // ── Apply accent color as CSS custom properties ────────────────
  useEffect(() => {
    const vars = buildAccentVars(accentColor);
    const root = document.documentElement;
    for (const [prop, val] of Object.entries(vars)) {
      root.style.setProperty(prop, val);
    }
    localStorage.setItem("accent-color", accentColor);
  }, [accentColor]);

  // ── Persist instant analysis settings & sync ref ────────────────
  useEffect(() => {
    instantAnalysisEnabledRef.current = instantAnalysisEnabled;
    localStorage.setItem("instant-analysis", String(instantAnalysisEnabled));
  }, [instantAnalysisEnabled]);

  useEffect(() => {
    localStorage.setItem("analysis-mode", analysisMode);
  }, [analysisMode]);

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
      let result: Base64Image;

      if (screenshotMode === "window") {
        if (!pinnedWindowId) {
          // No window pinned yet — open the picker
          openWindowPicker();
          return;
        }
        try {
          result = await invoke<Base64Image>("capture_window_screenshot", {
            windowId: pinnedWindowId,
          });
        } catch (err) {
          // Window likely closed — clear pin and show error
          console.error("Window capture failed:", err);
          setPinnedWindowId(null);
          setPinnedWindowTitle(null);
          setErrorMessage("Pinned window is no longer available. Please select a new window.");
          openWindowPicker();
          return;
        }
      } else {
        result = await invoke<Base64Image>("capture_monitor_screenshot", {
          monitorIndex: null,
        });
      }

      // Open region capture overlay
      setRegionCaptureScreenshot(toDataUrl(result.data, result.mime_type));
    } catch (err) {
      console.error("Screenshot failed:", err);
    }
  };

  const openWindowPicker = async () => {
    try {
      const windows = await invoke<WindowInfo[]>("list_windows");
      // Filter out our own app window and any with empty titles
      const filtered = windows.filter(
        (w) => w.app_name !== "desktop-chat" && w.title.trim() !== ""
      );
      setWindowList(filtered);
      setShowWindowPicker(true);
    } catch (err) {
      console.error("Failed to list windows:", err);
      setErrorMessage("Failed to list windows. Please try again.");
    }
  };

  const selectWindow = (w: WindowInfo) => {
    setPinnedWindowId(w.id);
    setPinnedWindowTitle(w.title);
    setShowWindowPicker(false);
  };

  // ── Region capture handlers ──────────────────────────────────────

  const handleRegionImageLoad = useCallback(() => {
    // Skip re-centering on live refreshes — only init on first load
    if (regionInitializedRef.current) return;
    regionInitializedRef.current = true;

    const overlay = regionOverlayRef.current;
    if (!overlay) return;
    const ow = overlay.clientWidth;
    const oh = overlay.clientHeight;
    const w = Math.min(400, ow - 40);
    const h = Math.min(300, oh - 40);
    setRegionSelection({
      x: Math.round((ow - w) / 2),
      y: Math.round((oh - h) / 2),
      width: w,
      height: h,
    });
  }, []);

  const handleRegionPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Check if clicking on a resize handle
      const target = e.target as HTMLElement;
      const handle = target.dataset.handle;
      if (handle) {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setRegionDragState({
          type: "resize",
          handle,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startSelection: { ...regionSelection },
        });
        return;
      }

      // Check if clicking inside the selection frame (for move)
      const rect = regionOverlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { x, y, width, height } = regionSelection;
      if (mx >= x && mx <= x + width && my >= y && my <= y + height) {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setRegionDragState({
          type: "move",
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startSelection: { ...regionSelection },
        });
      }
    },
    [regionSelection]
  );

  const handleRegionPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!regionDragState) return;
      const overlay = regionOverlayRef.current;
      if (!overlay) return;

      const ow = overlay.clientWidth;
      const oh = overlay.clientHeight;
      const dx = e.clientX - regionDragState.startMouseX;
      const dy = e.clientY - regionDragState.startMouseY;
      const s = regionDragState.startSelection;
      const MIN = 50;

      if (regionDragState.type === "move") {
        setRegionSelection({
          x: Math.max(0, Math.min(ow - s.width, s.x + dx)),
          y: Math.max(0, Math.min(oh - s.height, s.y + dy)),
          width: s.width,
          height: s.height,
        });
      } else {
        const h = regionDragState.handle!;
        let nx = s.x, ny = s.y, nw = s.width, nh = s.height;

        // Horizontal resize
        if (h.includes("w")) {
          nw = Math.max(MIN, s.width - dx);
          nx = s.x + s.width - nw;
          if (nx < 0) { nw += nx; nx = 0; }
        }
        if (h.includes("e")) {
          nw = Math.max(MIN, s.width + dx);
          if (nx + nw > ow) nw = ow - nx;
        }

        // Vertical resize
        if (h.includes("n")) {
          nh = Math.max(MIN, s.height - dy);
          ny = s.y + s.height - nh;
          if (ny < 0) { nh += ny; ny = 0; }
        }
        if (h.includes("s")) {
          nh = Math.max(MIN, s.height + dy);
          if (ny + nh > oh) nh = oh - ny;
        }

        setRegionSelection({ x: nx, y: ny, width: nw, height: nh });
      }
    },
    [regionDragState]
  );

  const handleRegionPointerUp = useCallback(() => {
    setRegionDragState(null);
  }, []);

  const cropRegionFromScreenshot = useCallback((): PendingImage | null => {
    const img = regionImageRef.current;
    const overlay = regionOverlayRef.current;
    if (!img || !overlay) return null;

    // Map display coords to actual image pixel coords (handles HiDPI)
    const scaleX = img.naturalWidth / overlay.clientWidth;
    const scaleY = img.naturalHeight / overlay.clientHeight;

    const sx = Math.round(regionSelection.x * scaleX);
    const sy = Math.round(regionSelection.y * scaleY);
    const sw = Math.round(regionSelection.width * scaleX);
    const sh = Math.round(regionSelection.height * scaleY);

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];

    return {
      id: nextImageId(),
      base64,
      mimeType: "image/png",
      preview: dataUrl,
    };
  }, [regionSelection]);

  // ── Instant analysis ────────────────────────────────────────────────

  const saveAnalysisToChat = async (image: PendingImage, analysis: string) => {
    try {
      let sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        const title = analysis.slice(0, 50) || "Screenshot Analysis";
        const newSession = await createSession(title);
        if (!newSession) return;
        sessionId = newSession.id;
      }

      let imageUrl: string | undefined;
      if (user) {
        try {
          imageUrl = await uploadImageToStorage(image.base64, image.mimeType, user.id);
        } catch {
          imageUrl = toDataUrl(image.base64, image.mimeType);
        }
      } else {
        imageUrl = toDataUrl(image.base64, image.mimeType);
      }

      await addMessage(sessionId, "user", "", imageUrl);
      await addMessage(sessionId, "assistant", analysis);
      loadSessions();
    } catch (err) {
      console.error("Failed to save analysis to chat:", err);
    }
  };

  const performInstantAnalysis = async (image: PendingImage) => {
    const gen = ++analysisGenRef.current;
    const modeConfig = ANALYSIS_MODES[analysisMode];

    setAnalysisStreamingContent("");
    setAnalysisComplete(null);
    setAnalysisError(null);
    setIsAnalyzing(true);
    setIsAnalysisSearching(false);
    analysisCompleteRef.current = null;
    analysisImageRef.current = image;

    // Downsize image for faster API processing
    const smallBase64 = await downsizeImageBase64(image.base64, image.mimeType, 1024);
    if (gen !== analysisGenRef.current) return; // cancelled during resize
    const imageDataUrl = toDataUrl(smallBase64, image.mimeType);

    await streamChatCompletion(
      [{ role: "user", content: modeConfig.userMessage, image_url: imageDataUrl }],
      {
        onToken: (token) => {
          if (gen !== analysisGenRef.current) return;
          setAnalysisStreamingContent((prev) => prev + token);
        },
        onComplete: (fullText) => {
          if (gen !== analysisGenRef.current) return;
          setAnalysisComplete(fullText);
          setIsAnalyzing(false);
          analysisCompleteRef.current = fullText;
          saveAnalysisToChat(image, fullText);
        },
        onError: (error) => {
          if (gen !== analysisGenRef.current) return;
          setAnalysisError(error.message);
          setIsAnalyzing(false);
          setIsAnalysisSearching(false);
        },
        onWebSearchStart: () => {
          if (gen !== analysisGenRef.current) return;
          setIsAnalysisSearching(true);
        },
        onWebSearchComplete: () => {
          if (gen !== analysisGenRef.current) return;
          setIsAnalysisSearching(false);
        },
      },
      {
        model: "gpt-4o",
        maxTokens: modeConfig.maxTokens,
        systemPrompt: modeConfig.systemPrompt,
        webSearch: modeConfig.webSearch,
      }
    );
  };

  // Keep ref in sync for use inside useCallback
  performInstantAnalysisRef.current = performInstantAnalysis;

  const handleRegionCapture = useCallback(() => {
    const cropped = cropRegionFromScreenshot();
    if (cropped) {
      setPendingImages((prev) => [...prev, cropped]);
      setCaptureFlashKey((k) => k + 1);
      if (instantAnalysisEnabledRef.current) {
        performInstantAnalysisRef.current?.(cropped);
      }
    }
  }, [cropRegionFromScreenshot]);

  const closeRegionCapture = useCallback(() => {
    // Signal the live-refresh loop to stop *immediately*, before React
    // re-renders and runs effect cleanup. This prevents in-flight or
    // queued refreshes from re-opening the overlay.
    liveRefreshStoppedRef.current = true;
    setRegionCaptureScreenshot(null);
    setRegionDragState(null);
    regionInitializedRef.current = false;
    setCaptureFlashKey(0);
    // Reset instant analysis state
    setAnalysisStreamingContent("");
    setAnalysisComplete(null);
    setAnalysisError(null);
    setIsAnalyzing(false);
    setIsAnalysisSearching(false);
    analysisCompleteRef.current = null;
    analysisImageRef.current = null;
  }, []);

  // ── Region capture keyboard shortcuts ──────────────────────────────
  useEffect(() => {
    if (!regionCaptureScreenshot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRegionCapture();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleRegionCapture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [regionCaptureScreenshot, closeRegionCapture, handleRegionCapture]);

  // ── Live window refresh ───────────────────────────────────────────
  // Chain captures back-to-back with a short gap so the preview stays
  // responsive. Using recursive setTimeout instead of setInterval avoids
  // overlapping captures and keeps perceived latency low (~300ms gap
  // between the end of one capture and the start of the next).
  const isWindowLiveMode = regionCaptureScreenshot !== null && screenshotMode === "window" && pinnedWindowId !== null;

  useEffect(() => {
    if (!isWindowLiveMode || !pinnedWindowId) return;

    // Reset the stop signal when starting a new live session
    liveRefreshStoppedRef.current = false;
    let cancelled = false;

    const isStopped = () => cancelled || liveRefreshStoppedRef.current;

    const refresh = async () => {
      if (isStopped()) return;

      // Pause captures while user is dragging the selection
      if (regionDragStateRef.current) {
        if (!isStopped()) setTimeout(refresh, 150);
        return;
      }

      try {
        const result = await invoke<Base64Image>("capture_window_screenshot", {
          windowId: pinnedWindowId,
        });
        if (!isStopped()) {
          setRegionCaptureScreenshot(toDataUrl(result.data, result.mime_type));
        }
      } catch {
        // Window may be briefly unavailable — skip this tick
      }

      if (!isStopped()) setTimeout(refresh, 300);
    };

    // Kick off the first capture after a short delay
    const timerId = setTimeout(refresh, 300);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [isWindowLiveMode, pinnedWindowId]);

  // Close screenshot mode menu on click outside
  useEffect(() => {
    if (!screenshotModeMenuOpen) return;
    const onClick = () => setScreenshotModeMenuOpen(false);
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [screenshotModeMenuOpen]);

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
      // Base64 data URLs for OpenAI (so the model can see images directly
      // without needing to fetch a remote Supabase Storage URL)
      const additionalImageDataUrls: string[] = [];

      // Upload the first image (attached to the main text message)
      let firstImageUrl: string | undefined;
      const firstImageDataUrl = imagesToSend.length > 0
        ? toDataUrl(imagesToSend[0].base64, imagesToSend[0].mimeType)
        : undefined;
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
            additionalImageDataUrls.push(toDataUrl(img.base64, img.mimeType));
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
        // Primary user message sent above — use base64 data URL so OpenAI
        // can see the image directly without fetching a remote URL
        { role: "user", content: text, image_url: firstImageDataUrl ?? null },
        // Any additional image-only messages
        ...additionalImageDataUrls.map((url) => ({
          role: "user" as const,
          content: "",
          image_url: url ?? null,
        })),
      ];

      // Stream AI response from OpenAI
      let aiResponseText = "";
      let responseCitations: UrlCitation[] = [];
      setIsSearching(false);

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
          onComplete: (fullText, citations) => {
            aiResponseText = fullText;
            responseCitations = citations;
            setIsSearching(false);
          },
          onError: (error) => {
            console.error("OpenAI streaming error:", error.message);
            aiResponseText = `Sorry, I wasn't able to respond — ${error.message}`;
            setIsSearching(false);
          },
          onWebSearchStart: () => {
            if (activeSessionIdRef.current === sendingSessionIdRef.current) {
              setIsSearching(true);
            }
          },
          onWebSearchComplete: () => {
            setIsSearching(false);
          },
        },
        { systemPrompt: SYSTEM_PROMPT, webSearch: webSearchEnabled }
      );

      // Save the AI response to Supabase (updates session timestamp too)
      // Append citation links to the stored message so they persist
      let storedResponse = aiResponseText;
      if (responseCitations.length > 0 && aiResponseText) {
        const citationLinks = responseCitations
          .map((c) => `[${c.title}](${c.url})`)
          .filter((v, i, a) => a.indexOf(v) === i) // dedupe
          .join("\n");
        storedResponse = `${aiResponseText}\n\nSources:\n${citationLinks}`;
      }
      if (storedResponse) {
        await addMessage(sessionId, "assistant", storedResponse);
      }

      // Refresh session list to update timestamps
      loadSessions();
    } catch (err) {
      console.error("Failed to send message:", err);
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to send message. Please try again."
      );
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

  // ── UI helpers ──────────────────────────────────────────────────────
  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setSidebarOpen(false); // close sidebar on mobile
  };

  const openImageModal = (url: string | null) => {
    if (!url) return;
    setImageModalUrl(url);
    setImageZoomed(false);
  };

  const closeImageModal = () => {
    setImageModalUrl(null);
    setImageZoomed(false);
  };

  // ── Derived state ──────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // ── Render: Loading ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <span>Loading your chats…</span>
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
      {/* ── Sidebar overlay (mobile) ──────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
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
                onClick={() => selectSession(session.id)}
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
          <div className="sidebar-footer-actions">
            <button
              className="btn-settings"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              className="btn-sign-out"
              onClick={() => supabase.auth.signOut()}
            >
              Sign Out
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="main-content">
        {activeSession ? (
          <>
            <div className="chat-header">
              <button
                className="btn-sidebar-toggle"
                onClick={() => setSidebarOpen((prev) => !prev)}
                title="Toggle sidebar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <h2>{activeSession.title}</h2>
              <span className="chat-header-time">
                Created {formatTime(activeSession.created_at)}
              </span>
            </div>

            {/* ── Error banner ──────────────────────────────────────── */}
            {errorMessage && (
              <div className="error-banner">
                <span className="error-banner-icon">⚠</span>
                <span className="error-banner-text">{errorMessage}</span>
                <button
                  className="error-banner-dismiss"
                  onClick={() => setErrorMessage(null)}
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            )}

            {/* ── Message list ──────────────────────────────────────── */}
            <div className="messages-container" ref={messagesContainerRef}>
              {messages.length === 0 && !sending ? (
                <div className="empty-state">
                  <div className="empty-state-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
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
                        {msg.role === "user" ? "You" : "AI"}
                      </div>
                      {msg.content && (
                        <div className="message-text">{msg.content}</div>
                      )}
                      {msg.image_url && (
                        <img
                          src={msg.image_url}
                          alt="Attached image"
                          className="message-image"
                          onClick={() => openImageModal(msg.image_url)}
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
                      <div className="message-role">AI</div>
                      {isSearching && !streamingContent && (
                        <div className="searching-indicator">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                          </svg>
                          Searching the web...
                        </div>
                      )}
                      {streamingContent ? (
                        <div className="message-text">{streamingContent}</div>
                      ) : !isSearching ? (
                        <div className="typing-indicator">
                          <span />
                          <span />
                          <span />
                        </div>
                      ) : null}
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
                  <div className="screenshot-btn-group">
                    <button
                      className="btn-input-action"
                      title={screenshotMode === "window" && pinnedWindowTitle
                        ? `Screenshot: ${pinnedWindowTitle}`
                        : "Take screenshot"}
                      onClick={handleScreenshot}
                      disabled={sending}
                    >
                      {screenshotMode === "window" ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <line x1="2" y1="8" x2="22" y2="8" />
                          <circle cx="5" cy="6" r="0.5" fill="currentColor" />
                          <circle cx="7.5" cy="6" r="0.5" fill="currentColor" />
                          <circle cx="10" cy="6" r="0.5" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="btn-screenshot-caret"
                      title="Screenshot mode"
                      onClick={(e) => {
                        e.stopPropagation();
                        setScreenshotModeMenuOpen((prev) => !prev);
                      }}
                      disabled={sending}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {/* Screenshot mode dropdown */}
                    {screenshotModeMenuOpen && (
                      <div className="screenshot-mode-menu" onClick={(e) => e.stopPropagation()}>
                        <button
                          className={`screenshot-mode-option ${screenshotMode === "screen" ? "active" : ""}`}
                          onClick={() => {
                            setScreenshotMode("screen");
                            setScreenshotModeMenuOpen(false);
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <span>Full Screen</span>
                          {screenshotMode === "screen" && (
                            <svg className="check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                        <button
                          className={`screenshot-mode-option ${screenshotMode === "window" ? "active" : ""}`}
                          onClick={() => {
                            setScreenshotMode("window");
                            setScreenshotModeMenuOpen(false);
                            if (!pinnedWindowId) {
                              openWindowPicker();
                            }
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="4" width="20" height="16" rx="2" />
                            <line x1="2" y1="8" x2="22" y2="8" />
                          </svg>
                          <span>Window</span>
                          {screenshotMode === "window" && (
                            <svg className="check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                        {screenshotMode === "window" && pinnedWindowTitle && (
                          <>
                            <div className="screenshot-mode-divider" />
                            <div className="screenshot-mode-pinned">
                              <span className="pinned-label">Pinned:</span>
                              <span className="pinned-title">{pinnedWindowTitle}</span>
                            </div>
                            <button
                              className="screenshot-mode-option"
                              onClick={() => {
                                setScreenshotModeMenuOpen(false);
                                openWindowPicker();
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                              <span>Change window...</span>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
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
                  <button
                    className={`btn-input-action ${webSearchEnabled ? "active" : ""}`}
                    title={webSearchEnabled ? "Web search enabled" : "Enable web search"}
                    onClick={() => setWebSearchEnabled((prev) => !prev)}
                    disabled={sending}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
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
          <>
            <div className="chat-header">
              <button
                className="btn-sidebar-toggle"
                onClick={() => setSidebarOpen((prev) => !prev)}
                title="Toggle sidebar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p>Select a conversation or start a new chat</p>
              <span className="hint">
                Your chat sessions appear in the sidebar
              </span>
            </div>
          </>
        )}
      </main>

      {/* ── Image lightbox modal with zoom ───────────────────────────── */}
      {imageModalUrl && (
        <div
          className="image-modal-overlay"
          onClick={closeImageModal}
        >
          <div className="image-modal" onClick={(e) => e.stopPropagation()}>
            <img
              src={imageModalUrl}
              alt="Full size"
              className={imageZoomed ? "zoomed" : ""}
              onClick={() => setImageZoomed((z) => !z)}
              draggable={false}
            />
            <button
              className="image-modal-close"
              onClick={closeImageModal}
            >
              ✕
            </button>
            <div className="image-modal-hint">
              {imageZoomed ? "Click to zoom out" : "Click image to zoom in"}
            </div>
          </div>
        </div>
      )}

      {/* ── Region capture overlay ────────────────────────────────────── */}
      {regionCaptureScreenshot && (
        <div
          className="region-capture-overlay"
          ref={regionOverlayRef}
          onPointerDown={handleRegionPointerDown}
          onPointerMove={handleRegionPointerMove}
          onPointerUp={handleRegionPointerUp}
        >
          {/* Full screenshot as background */}
          <img
            ref={regionImageRef}
            src={regionCaptureScreenshot}
            alt=""
            className="region-capture-bg"
            onLoad={handleRegionImageLoad}
            draggable={false}
          />

          {/* Dark mask — 4 strips around selection */}
          <div className="region-mask" style={{ top: 0, left: 0, right: 0, height: regionSelection.y }} />
          <div className="region-mask" style={{ top: regionSelection.y, left: 0, width: regionSelection.x, height: regionSelection.height }} />
          <div className="region-mask" style={{ top: regionSelection.y, left: regionSelection.x + regionSelection.width, right: 0, height: regionSelection.height }} />
          <div className="region-mask" style={{ top: regionSelection.y + regionSelection.height, left: 0, right: 0, bottom: 0 }} />

          {/* Selection frame */}
          <div
            className="region-selection-frame"
            style={{
              left: regionSelection.x,
              top: regionSelection.y,
              width: regionSelection.width,
              height: regionSelection.height,
            }}
          >
            {/* Resize handles */}
            <div className="region-handle nw" data-handle="nw" />
            <div className="region-handle n" data-handle="n" />
            <div className="region-handle ne" data-handle="ne" />
            <div className="region-handle w" data-handle="w" />
            <div className="region-handle e" data-handle="e" />
            <div className="region-handle sw" data-handle="sw" />
            <div className="region-handle s" data-handle="s" />
            <div className="region-handle se" data-handle="se" />

            {/* Dimensions label */}
            <div className="region-dimensions">
              {Math.round(regionSelection.width)} x {Math.round(regionSelection.height)}
            </div>

            {/* Capture flash overlay */}
            {captureFlashKey > 0 && (
              <div key={captureFlashKey} className="region-capture-flash" />
            )}
          </div>

          {/* LIVE badge (window mode only) */}
          {isWindowLiveMode && (
            <div className="region-live-badge">
              <span className="region-live-dot" />
              LIVE
            </div>
          )}

          {/* Toolbar */}
          <div
            className="region-toolbar"
            style={{
              left: regionSelection.x + regionSelection.width / 2,
              top: regionSelection.y + regionSelection.height + 12 > (regionOverlayRef.current?.clientHeight ?? 0) - 60
                ? regionSelection.y - 48
                : regionSelection.y + regionSelection.height + 12,
            }}
          >
            <button
              className="region-btn-capture"
              onClick={(e) => { e.stopPropagation(); handleRegionCapture(); }}
              title="Capture region (Enter)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
            <button
              className="region-btn-close"
              onClick={(e) => { e.stopPropagation(); closeRegionCapture(); }}
              title={isWindowLiveMode ? "Done (Esc)" : "Close (Esc)"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Hint text */}
          <div className="region-hint">
            {isWindowLiveMode
              ? "Cmd+Tab to scroll target · Enter to capture · Esc when done"
              : "Drag to move · Handles to resize · Enter to capture · Esc to close"}
          </div>

          {/* Instant analysis panel */}
          {(isAnalyzing || analysisStreamingContent || analysisError) && (
            <div className="analysis-panel">
              <div className="analysis-header">
                <div className="analysis-header-left">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  <span className="analysis-title">AI · {ANALYSIS_MODES[analysisMode].label}</span>
                </div>
                {isAnalyzing && !analysisComplete && (
                  <div className="loading-spinner small analysis-spinner" />
                )}
                {analysisComplete && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#50c878" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              <div className="analysis-body">
                {analysisError ? (
                  <div className="analysis-error">{analysisError}</div>
                ) : (
                  <>
                    {isAnalysisSearching && !analysisStreamingContent && (
                      <div className="analysis-searching">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        Searching the web...
                      </div>
                    )}
                    <div className="analysis-text">
                      {analysisComplete || analysisStreamingContent || (isAnalysisSearching ? "" : "Analyzing...")}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Window picker modal ─────────────────────────────────────── */}
      {showWindowPicker && (
        <div
          className="window-picker-overlay"
          onClick={() => setShowWindowPicker(false)}
        >
          <div
            className="window-picker"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="window-picker-header">
              <h3>Select a Window</h3>
              <button
                className="window-picker-close"
                onClick={() => setShowWindowPicker(false)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="window-picker-list">
              {windowList.length === 0 ? (
                <div className="window-picker-empty">
                  No windows found
                </div>
              ) : (
                windowList.map((w) => (
                  <button
                    key={w.id}
                    className={`window-picker-item ${pinnedWindowId === w.id ? "active" : ""}`}
                    onClick={() => selectWindow(w)}
                  >
                    <div className="window-picker-item-info">
                      <span className="window-picker-app">{w.app_name}</span>
                      <span className="window-picker-title">{w.title}</span>
                    </div>
                    <span className="window-picker-size">{w.width}x{w.height}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Settings panel ────────────────────────────────────────────── */}
      {settingsOpen && (
        <div
          className="settings-overlay"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="settings-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-header">
              <h3>Settings</h3>
              <button
                className="settings-close"
                onClick={() => setSettingsOpen(false)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Theme mode */}
            <div className="settings-section">
              <label className="settings-label">Appearance</label>
              <div className="theme-switcher">
                {(["dark", "light", "system"] as ThemeMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={`theme-option ${themeMode === mode ? "active" : ""}`}
                    onClick={() => setThemeMode(mode)}
                  >
                    {mode === "dark" && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                    {mode === "light" && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="5" />
                        <line x1="12" y1="1" x2="12" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="23" />
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                        <line x1="1" y1="12" x2="3" y2="12" />
                        <line x1="21" y1="12" x2="23" y2="12" />
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                      </svg>
                    )}
                    {mode === "system" && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                    )}
                    <span>{mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Accent color */}
            <div className="settings-section">
              <label className="settings-label">Accent Color</label>
              <div className="accent-grid">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.color}
                    className={`accent-swatch ${accentColor === preset.color ? "active" : ""}`}
                    style={{ "--swatch-color": preset.color } as React.CSSProperties}
                    onClick={() => setAccentColor(preset.color)}
                    title={preset.name}
                  >
                    {accentColor === preset.color && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
                {/* Custom color picker */}
                <div className={`accent-swatch custom ${!ACCENT_PRESETS.some((p) => p.color === accentColor) ? "active" : ""}`}>
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="accent-color-input"
                    title="Custom color"
                  />
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Screenshot Analysis */}
            <div className="settings-section">
              <label className="settings-label">Screenshot Analysis</label>
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-title">Instant Analysis</span>
                  <span className="settings-toggle-desc">
                    Automatically analyze captured regions with GPT-4o
                  </span>
                </div>
                <button
                  className={`settings-toggle ${instantAnalysisEnabled ? "active" : ""}`}
                  onClick={() => setInstantAnalysisEnabled((prev) => !prev)}
                  role="switch"
                  aria-checked={instantAnalysisEnabled}
                >
                  <span className="settings-toggle-thumb" />
                </button>
              </div>

              {instantAnalysisEnabled && (
                <>
                  <label className="settings-label" style={{ marginTop: 16 }}>Analysis Mode</label>
                  <div className="analysis-mode-switcher">
                    {(Object.keys(ANALYSIS_MODES) as AnalysisMode[]).map((mode) => (
                      <button
                        key={mode}
                        className={`analysis-mode-option ${analysisMode === mode ? "active" : ""}`}
                        onClick={() => setAnalysisMode(mode)}
                      >
                        {mode === "general" && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 16v-4" />
                            <path d="M12 8h.01" />
                          </svg>
                        )}
                        {mode === "sports" && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                            <path d="M2 12h20" />
                          </svg>
                        )}
                        {mode === "code" && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="16 18 22 12 16 6" />
                            <polyline points="8 6 2 12 8 18" />
                          </svg>
                        )}
                        {mode === "quiz" && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 11l3 3L22 4" />
                            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                          </svg>
                        )}
                        <span>{ANALYSIS_MODES[mode].label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
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
