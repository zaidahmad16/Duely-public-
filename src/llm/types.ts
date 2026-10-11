// One AI provider, chosen by the student: OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek,
// Mistral, Together, local Ollama / LM Studio …), Anthropic or Google Gemini. Everything in Duely
// talks to it through this interface, so the engine never knows which one it is.

export type Image = { mime: string; b64: string };
export type ToolCall = { id: string; name: string; args: any; /** Gemini: the call's thought signature, sent back with it next turn */ sig?: string };
export type Msg =
  | { role: "system" | "user"; content: string; images?: Image[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export type Tool = { name: string; description: string; parameters: object };

export type ChatOpts = {
  tools?: Tool[];
  /** ask for a JSON answer matching this schema (providers that can't enforce it get it in the prompt) */
  schema?: object;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};
export type ChatResult = { content: string; toolCalls: ToolCall[]; usage: { input: number; output: number } };

export interface LLM {
  /** e.g. "Gemini · gemini-2.5-flash" */
  readonly label: string;
  chat(messages: Msg[], opts?: ChatOpts): Promise<ChatResult>;
}

export type Provider = "openai" | "anthropic" | "gemini";
export type LLMConfig = { provider: Provider; apiKey: string; model: string; baseUrl?: string };

export class LLMError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
