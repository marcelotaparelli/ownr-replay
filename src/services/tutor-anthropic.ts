import type { TutorMessage } from "../domain/tutor.ts";
import type { TutorModel } from "./tutor.ts";

type ContentBlock = { type: string; text?: string };
type MessagesResponse = { content?: ContentBlock[]; stop_reason?: string };

/**
 * Claude via the Messages API over plain fetch (no SDK dependency).
 * Server-side refusal fallbacks are enabled; thinking stays adaptive (default)
 * with low effort, since tutor answers should be short and fast.
 * NOT VERIFIED against the live API in this environment (no key available).
 */
export class AnthropicTutorModel implements TutorModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async complete(input: { system: string; messages: TutorMessage[] }): Promise<string> {
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16_000,
        output_config: { effort: "low" },
        fallbacks: "default",
        system: input.system,
        messages: input.messages,
      }),
    });
    if (!response.ok) {
      throw new Error(`anthropic_http_${response.status}`);
    }
    const body = (await response.json()) as MessagesResponse;
    if (body.stop_reason === "refusal") throw new Error("anthropic_refusal");
    const text = (body.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("anthropic_empty_response");
    return text;
  }
}
