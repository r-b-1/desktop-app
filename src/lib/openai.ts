// ── OpenAI Responses API Service ──────────────────────────────────────
// GPT-4o mini via the Responses API with text + vision (base64 image)
// support, optional web search tool, streaming responses, and retry
// logic with exponential backoff.

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
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

/** A text content part for the Responses API input. */
type TextContentPart = {
  type: "input_text";
  text: string;
};

/** An image content part for the Responses API vision input. */
type ImageContentPart = {
  type: "input_image";
  image_url: string;
  detail?: "low" | "high" | "auto";
};

type ContentPart = TextContentPart | ImageContentPart;

/** A message in the Responses API input format. */
type InputMessage = {
  role: "user" | "assistant";
  content: string | ContentPart[];
};

/** A URL citation annotation returned by the web search tool. */
type UrlCitation = {
  type: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
};

/** Options for Responses API requests. */
type ChatCompletionOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  webSearch?: boolean;
};

/** Callbacks for streaming responses. */
type StreamCallbacks = {
  /** Called for each token as it arrives. */
  onToken: (token: string) => void;
  /** Called when the full response is complete. */
  onComplete: (fullText: string, citations: UrlCitation[]) => void;
  /** Called if an error occurs during streaming. */
  onError: (error: OpenAIError) => void;
  /** Called when a web search is in progress. */
  onWebSearchStart?: () => void;
  /** Called when a web search finishes. */
  onWebSearchComplete?: () => void;
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
 * Convert application message objects to the Responses API input format.
 * Handles both plain-text messages and vision messages with
 * base64-encoded images or image URLs.
 *
 * Note: system prompt is passed via `instructions` parameter in the
 * Responses API, not as a message in the input array.
 */
function formatInput(
  messages: ReadonlyArray<{
    role: string;
    content: string;
    image_url?: string | null;
  }>
): InputMessage[] {
  const formatted: InputMessage[] = [];

  for (const msg of messages) {
    const role = msg.role as InputMessage["role"];

    if (msg.image_url) {
      // Vision message: combine text and image in a multi-part content array
      const content: ContentPart[] = [];
      if (msg.content) {
        content.push({ type: "input_text", text: msg.content });
      }
      content.push({
        type: "input_image",
        image_url: msg.image_url,
        detail: "auto",
      });
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

// ── Streaming response ─────────────────────────────────────────────────

/**
 * Send a Responses API request and stream tokens back in real-time.
 *
 * Retry logic applies only to the initial HTTP connection (e.g. rate
 * limits). Once streaming begins, errors are forwarded to `onError`
 * without retry to avoid duplicate partial output.
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
    webSearch = false,
  } = options;

  const tools: Array<{ type: string }> = [];
  if (webSearch) {
    tools.push({ type: "web_search_preview" });
  }

  const body: Record<string, unknown> = {
    model,
    input: formatInput(messages),
    temperature,
    max_output_tokens: maxTokens,
    stream: true,
  };

  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

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
  const citations: UrlCitation[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      // Parse SSE events: "event: <type>\ndata: <json>\n\n"
      let currentEvent = "";
      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          if (currentEvent === "response.output_text.delta") {
            const token = parsed.delta as string | undefined;
            if (token) {
              fullText += token;
              callbacks.onToken(token);
            }
          } else if (
            currentEvent === "response.web_search_call.in_progress" ||
            currentEvent === "response.web_search_call.searching"
          ) {
            callbacks.onWebSearchStart?.();
          } else if (currentEvent === "response.web_search_call.completed") {
            callbacks.onWebSearchComplete?.();
          } else if (currentEvent === "response.output_text.annotation.added") {
            const annotation = parsed.annotation;
            if (annotation?.type === "url_citation") {
              citations.push({
                type: "url_citation",
                url: annotation.url,
                title: annotation.title,
                start_index: annotation.start_index,
                end_index: annotation.end_index,
              });
            }
          } else if (currentEvent === "response.completed") {
            // Extract any citations from the completed response output
            const output = parsed.response?.output;
            if (Array.isArray(output)) {
              for (const item of output) {
                if (item.type === "message" && Array.isArray(item.content)) {
                  for (const part of item.content) {
                    if (
                      part.type === "output_text" &&
                      Array.isArray(part.annotations)
                    ) {
                      for (const ann of part.annotations) {
                        if (ann.type === "url_citation") {
                          // Avoid duplicates from annotation.added events
                          const exists = citations.some(
                            (c) =>
                              c.url === ann.url &&
                              c.start_index === ann.start_index
                          );
                          if (!exists) {
                            citations.push({
                              type: "url_citation",
                              url: ann.url,
                              title: ann.title,
                              start_index: ann.start_index,
                              end_index: ann.end_index,
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } else if (currentEvent === "error") {
            const msg =
              (parsed.message as string) ?? "Streaming error from API";
            throw new OpenAIError(msg);
          }
        } catch (e) {
          if (e instanceof OpenAIError) throw e;
          // Skip malformed SSE chunks
        }

        currentEvent = "";
      }
    }

    callbacks.onComplete(fullText, citations);
  } catch (error) {
    callbacks.onError(
      error instanceof OpenAIError
        ? error
        : new OpenAIError(
            error instanceof Error ? error.message : "Stream read failed"
          )
    );
  } finally {
    reader.releaseLock();
  }
}

// ── Non-streaming response ─────────────────────────────────────────────

/**
 * Send a Responses API request and return the full response text.
 * Automatically retries on rate-limit and server errors.
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
    webSearch = false,
  } = options;

  const tools: Array<{ type: string }> = [];
  if (webSearch) {
    tools.push({ type: "web_search_preview" });
  }

  const body: Record<string, unknown> = {
    model,
    input: formatInput(messages),
    temperature,
    max_output_tokens: maxTokens,
  };

  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  return withRetry(async () => {
    const response = await fetch(OPENAI_API_URL, buildRequestInit(body));

    if (!response.ok) {
      const errorBody = await safeParseErrorBody(response);
      throw parseAPIError(response.status, errorBody);
    }

    const data = (await response.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{
          type: string;
          text?: string;
        }>;
      }>;
    };

    // Find the message output item and extract text
    const messageItem = data.output?.find((item) => item.type === "message");
    const textPart = messageItem?.content?.find(
      (part) => part.type === "output_text"
    );
    const content = textPart?.text;

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
  formatInput,
  formatInput as formatMessages,
  createBase64ImageUrl,
  OpenAIError,
};

export type {
  InputMessage,
  InputMessage as OpenAIMessage,
  ChatCompletionOptions,
  StreamCallbacks,
  UrlCitation,
  ContentPart,
  TextContentPart,
  ImageContentPart,
};
