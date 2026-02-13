// ── OpenAI API Service ─────────────────────────────────────────────────
// GPT-4o mini chat completions with text + vision (base64 image) support,
// streaming responses, and retry logic with exponential backoff.

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

// ── Configuration ──────────────────────────────────────────────────────

const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

if (!apiKey) {
  throw new Error(
    "Missing VITE_OPENAI_API_KEY environment variable. " +
      "Add it to your .env file."
  );
}

// ── Types ──────────────────────────────────────────────────────────────

/** A text content part for the OpenAI messages API. */
type TextContentPart = {
  type: "text";
  text: string;
};

/** An image content part for the OpenAI vision API. */
type ImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

type ContentPart = TextContentPart | ImageContentPart;

/** A message in the OpenAI chat completions API format. */
type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

/** Options for chat completion requests. */
type ChatCompletionOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
};

/** Callbacks for streaming chat completion. */
type StreamCallbacks = {
  /** Called for each token as it arrives. */
  onToken: (token: string) => void;
  /** Called when the full response is complete. */
  onComplete: (fullText: string) => void;
  /** Called if an error occurs during streaming. */
  onError: (error: OpenAIError) => void;
};

// ── Error handling ─────────────────────────────────────────────────────

/** Custom error class for OpenAI API errors with retry metadata. */
class OpenAIError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    status?: number,
    code?: string,
    retryable = false
  ) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Parse an error response body into a structured OpenAIError.
 * Rate-limit (429) and server errors (5xx) are marked as retryable.
 */
function parseAPIError(
  status: number,
  body: Record<string, unknown> | null
): OpenAIError {
  const errorObj = body?.error as Record<string, unknown> | undefined;
  const message =
    (errorObj?.message as string) ??
    `OpenAI API request failed with status ${status}`;
  const code = (errorObj?.code as string) ?? undefined;
  const retryable = status === 429 || status >= 500;

  return new OpenAIError(message, status, code, retryable);
}

// ── Retry logic ────────────────────────────────────────────────────────

/**
 * Execute `fn` with exponential backoff retry for retryable errors.
 * Delays: 1 s → 2 s → 4 s (configurable via INITIAL_DELAY_MS).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES
): Promise<T> {
  let lastError: OpenAIError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError =
        error instanceof OpenAIError
          ? error
          : new OpenAIError(
              error instanceof Error ? error.message : "Unknown error"
            );

      // Don't retry non-retryable errors or if we've exhausted retries
      if (!lastError.retryable || attempt === retries) {
        throw lastError;
      }

      // Exponential backoff with jitter
      const baseDelay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelay * 0.1;
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
    }
  }

  // TypeScript: unreachable, but satisfies return type
  throw lastError;
}

// ── Message formatting ─────────────────────────────────────────────────

/**
 * Convert application message objects to the OpenAI chat completions API
 * format. Handles both plain-text messages and vision messages with
 * base64-encoded images or image URLs.
 *
 * @param messages - Array of app-level messages (matching ChatMessage shape)
 * @param systemPrompt - Optional system prompt prepended to the conversation
 */
function formatMessages(
  messages: ReadonlyArray<{
    role: string;
    content: string;
    image_url?: string | null;
  }>,
  systemPrompt?: string
): OpenAIMessage[] {
  const formatted: OpenAIMessage[] = [];

  if (systemPrompt) {
    formatted.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const role = msg.role as OpenAIMessage["role"];

    if (msg.image_url) {
      // Vision message: combine text and image in a multi-part content array
      const content: ContentPart[] = [
        { type: "text", text: msg.content },
        {
          type: "image_url",
          image_url: {
            url: msg.image_url,
            detail: "auto",
          },
        },
      ];
      formatted.push({ role, content });
    } else {
      // Plain text message
      formatted.push({ role, content: msg.content });
    }
  }

  return formatted;
}

/**
 * Build a base64 data URL from raw image bytes, suitable for passing as
 * the `image_url` field in a message.
 *
 * @param base64Data - Base64-encoded image bytes (no prefix)
 * @param mimeType - Image MIME type (defaults to "image/png")
 */
function createBase64ImageUrl(
  base64Data: string,
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png"
): string {
  return `data:${mimeType};base64,${base64Data}`;
}

// ── Core API request ───────────────────────────────────────────────────

function buildRequestInit(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

async function safeParseErrorBody(
  response: Response
): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Streaming chat completion ──────────────────────────────────────────

/**
 * Send a chat completion request and stream tokens back in real-time.
 *
 * Retry logic applies only to the initial HTTP connection (e.g. rate
 * limits). Once streaming begins, errors are forwarded to `onError`
 * without retry to avoid duplicate partial output.
 *
 * @param messages - Conversation history
 * @param callbacks - Token, completion, and error handlers
 * @param options - Model, temperature, max tokens, system prompt
 */
async function streamChatCompletion(
  messages: ReadonlyArray<{
    role: string;
    content: string;
    image_url?: string | null;
  }>,
  callbacks: StreamCallbacks,
  options: ChatCompletionOptions = {}
): Promise<void> {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.7,
    maxTokens = 4096,
    systemPrompt,
  } = options;

  const body = {
    model,
    messages: formatMessages(messages, systemPrompt),
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  // Phase 1: Establish connection (with retry for rate limits / 5xx)
  let response: Response;
  try {
    response = await withRetry(async () => {
      const res = await fetch(OPENAI_API_URL, buildRequestInit(body));

      if (!res.ok) {
        const errorBody = await safeParseErrorBody(res);
        throw parseAPIError(res.status, errorBody);
      }

      return res;
    });
  } catch (error) {
    callbacks.onError(
      error instanceof OpenAIError
        ? error
        : new OpenAIError(
            error instanceof Error ? error.message : "Connection failed"
          )
    );
    return;
  }

  // Phase 2: Read the SSE stream (no retry — avoid duplicate partial output)
  if (!response.body) {
    callbacks.onError(new OpenAIError("Response body is null"));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6); // strip "data: "
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            callbacks.onToken(token);
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    callbacks.onComplete(fullText);
  } catch (error) {
    callbacks.onError(
      new OpenAIError(
        error instanceof Error ? error.message : "Stream read failed"
      )
    );
  } finally {
    reader.releaseLock();
  }
}

// ── Non-streaming chat completion ──────────────────────────────────────

/**
 * Send a chat completion request and return the full response text.
 * Automatically retries on rate-limit and server errors.
 *
 * @param messages - Conversation history
 * @param options - Model, temperature, max tokens, system prompt
 * @returns The assistant's response text
 */
async function chatCompletion(
  messages: ReadonlyArray<{
    role: string;
    content: string;
    image_url?: string | null;
  }>,
  options: ChatCompletionOptions = {}
): Promise<string> {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.7,
    maxTokens = 4096,
    systemPrompt,
  } = options;

  const body = {
    model,
    messages: formatMessages(messages, systemPrompt),
    temperature,
    max_tokens: maxTokens,
  };

  return withRetry(async () => {
    const response = await fetch(OPENAI_API_URL, buildRequestInit(body));

    if (!response.ok) {
      const errorBody = await safeParseErrorBody(response);
      throw parseAPIError(response.status, errorBody);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new OpenAIError("No content in API response");
    }

    return content;
  });
}

// ── Exports ────────────────────────────────────────────────────────────

export {
  streamChatCompletion,
  chatCompletion,
  formatMessages,
  createBase64ImageUrl,
  OpenAIError,
};

export type {
  OpenAIMessage,
  ChatCompletionOptions,
  StreamCallbacks,
  ContentPart,
  TextContentPart,
  ImageContentPart,
};
