export type ChatSession = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  image_url: string | null;
  created_at: string;
};

export type ChatSessionInsert = Omit<
  ChatSession,
  "id" | "created_at" | "updated_at"
>;

export type ChatMessageInsert = Omit<ChatMessage, "id" | "created_at">;
