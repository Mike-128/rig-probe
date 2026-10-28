import type Anthropic from "@anthropic-ai/sdk";
import type { ProbeContext } from "../types";

/**
 * Shared request scaffolding. max_tokens is generous because on current models thinking is on by
 * default and counts against it; output is billed as used, so a high cap costs nothing extra.
 * Effort is pinned low where the model supports it, which keeps thinking (and spend) small.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export interface BaseParams {
  model: string;
  max_tokens: number;
  output_config?: { effort: Effort };
}

export function base(ctx: ProbeContext, opts: { maxTokens?: number; effort?: Effort } = {}): BaseParams {
  const params: BaseParams = { model: ctx.model, max_tokens: opts.maxTokens ?? 4096 };
  if (ctx.support.forModel("effort") === "supported") params.output_config = { effort: opts.effort ?? "low" };
  return params;
}

type AnyMessage = { content: unknown[]; stop_reason?: string | null };
type Block = { type: string; [k: string]: unknown };

export function textOf(msg: AnyMessage): string {
  return (msg.content as Block[])
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

export function blocksOf(msg: AnyMessage, type: string): Block[] {
  return (msg.content as Block[]).filter((b) => b.type === type);
}

export function toolUses(msg: AnyMessage): { id: string; name: string; input: Record<string, unknown> }[] {
  return blocksOf(msg, "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
}

export function excerpt(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat || "(empty)";
}

export const WEATHER_TOOL: Anthropic.Tool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string", description: "City name, e.g. Paris" } },
    required: ["city"],
  },
};

export const CODEWORD_TOOL: Anthropic.Tool = {
  name: "get_codeword",
  description: "Returns today's access codeword. Call this whenever the user asks for the codeword.",
  input_schema: { type: "object", properties: {}, required: [] },
};

export const CODEWORD = "MARMOT-19";

export function weatherFor(city: string): string {
  return `${city}: sunny, 21°C, wind 5 km/h. Reference code WX-${Math.abs(hash(city)) % 9000 + 1000}.`;
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

/**
 * Server tools can stop with pause_turn on long turns; resume by sending the paused assistant turn
 * back. Returns the final message and every message seen.
 */
export async function runWithPauseTurn(
  ctx: ProbeContext,
  send: (messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>,
  first: Anthropic.MessageParam[],
  maxResumes = 3,
): Promise<{ final: Anthropic.Message; all: Anthropic.Message[] }> {
  const messages = [...first];
  const all: Anthropic.Message[] = [];
  let res = await send(messages);
  all.push(res);
  for (let i = 0; i < maxResumes && res.stop_reason === "pause_turn"; i++) {
    ctx.note(`Turn paused (pause_turn); resuming (${i + 1}/${maxResumes}).`);
    messages.push({ role: "assistant", content: res.content });
    ctx.label(`resume after pause_turn #${i + 1}`);
    res = await send(messages);
    all.push(res);
  }
  return { final: res, all };
}
