import type Anthropic from "@anthropic-ai/sdk";
import { SkipProbe } from "../types";
import { defineProbe } from "../types";
import { base, excerpt, textOf, WEATHER_TOOL } from "./_util";

/**
 * Every case here sends an anthropic-beta header. If a gateway strips it, the API sees a beta-only
 * field without the beta and rejects it as unknown; the classifier recognizes that and says so.
 */
const NOTE_BETA = "Beta requests go to the same /v1/messages route, distinguished only by the anthropic-beta header. A 400 naming an unknown field here usually means the gateway dropped the header.";

export const beta = [
  defineProbe({
    id: "TC-BETA-01",
    title: "Compaction configuration accepted",
    category: "beta",
    purpose:
      "Checks the server-side compaction beta reaches the API. Compaction only fires once input passes its trigger (at least 50,000 tokens), so this verifies the beta header and configuration are accepted rather than paying to trigger a compaction.",
    surface: "POST /v1/messages · anthropic-beta: compact-2026-01-12 · context_management.edits compact_20260112",
    steps: ["Send a short request with a compaction edit and a 50,000-token trigger."],
    expected: "HTTP 200. Without the beta header, the API rejects context_management as an unknown field.",
    betas: ["compact-2026-01-12"],
    cost: "low",
    feature: "compaction",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["compact-2026-01-12"],
        context_management: { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 50_000 } }] },
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("Compaction configuration accepted", res.type === "message");
      ctx.note(NOTE_BETA);
    },
  }),

  defineProbe({
    id: "TC-BETA-02",
    title: "Context editing configuration accepted",
    category: "beta",
    purpose: "Checks the context editing beta, which clears old tool results from long conversations, reaches the API.",
    surface: "POST /v1/messages · anthropic-beta: context-management-2025-06-27 · clear_tool_uses_20250919",
    steps: ["Send a request with a clear_tool_uses edit and a tool defined."],
    expected: "HTTP 200.",
    betas: ["context-management-2025-06-27"],
    cost: "low",
    feature: "context_editing",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["context-management-2025-06-27"],
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        tools: [WEATHER_TOOL],
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("Context editing configuration accepted", res.type === "message");
      ctx.note(NOTE_BETA);
    },
  }),

  defineProbe({
    id: "TC-BETA-03",
    title: "Cache diagnostics",
    category: "beta",
    purpose:
      "Checks the cache diagnostics beta. It is a clean test of header passthrough: with the header the response carries a diagnostics object; without it the request is rejected. Anthropic API only.",
    surface: "POST /v1/messages · anthropic-beta: cache-diagnosis-2026-04-07 · diagnostics",
    steps: ["Send a request with diagnostics.previous_message_id null."],
    expected: "HTTP 200 with a diagnostics field in the response.",
    betas: ["cache-diagnosis-2026-04-07"],
    cost: "low",
    feature: "cache_diagnostics",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["cache-diagnosis-2026-04-07"],
        diagnostics: { previous_message_id: null },
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("Request with diagnostics accepted", res.type === "message");
      ctx.advise("Response carries diagnostics", "diagnostics" in res && (res as { diagnostics?: unknown }).diagnostics !== undefined, excerpt(JSON.stringify((res as { diagnostics?: unknown }).diagnostics ?? null)));
    },
  }),

  defineProbe({
    id: "TC-BETA-04",
    title: "Fast mode",
    category: "beta",
    purpose: "Checks fast mode (research preview), which runs the same model at higher output speed and premium price. Claude Opus 5.5, Opus 5, and Opus 4.8 on the Anthropic API only.",
    surface: "POST /v1/messages · anthropic-beta: fast-mode-2026-02-01 · speed: fast",
    steps: ["Send a request with speed fast."],
    expected: "HTTP 200 with usage.speed reported as fast.",
    betas: ["fast-mode-2026-02-01"],
    cost: "low",
    feature: "fast_mode",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["fast-mode-2026-02-01"],
        speed: "fast",
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("Fast mode request accepted", res.type === "message");
      const speed = (res.usage as { speed?: string }).speed;
      ctx.advise("usage.speed reports fast", speed === "fast", String(speed));
    },
  }),

  defineProbe({
    id: "TC-BETA-05",
    title: "Task budget",
    category: "beta",
    purpose: "Checks task budgets, which give the model a token budget for an agentic task so it paces itself and finishes cleanly. Anthropic API only.",
    surface: "POST /v1/messages (stream) · anthropic-beta: task-budgets-2026-03-13 · output_config.task_budget",
    steps: ["Stream a request with a 20,000-token task budget (the minimum)."],
    expected: "HTTP 200 and a complete response.",
    betas: ["task-budgets-2026-03-13"],
    cost: "low",
    feature: "task_budget",
    async run(ctx) {
      const b = base(ctx, { maxTokens: 16000 });
      const stream = ctx.client.beta.messages.stream({
        ...b,
        betas: ["task-budgets-2026-03-13"],
        output_config: { ...(b.output_config ?? {}), task_budget: { type: "tokens", total: 20_000 } },
        messages: [{ role: "user", content: "In two sentences, explain what a task budget is for." }],
      });
      const final = await stream.finalMessage();
      ctx.check("Task budget accepted", final.type === "message", String(final.stop_reason));
    },
  }),

  defineProbe({
    id: "TC-BETA-06",
    title: "Thinking display: updates",
    category: "beta",
    purpose: "Checks the updates display mode, which hides reasoning but returns the model's progress notes between tool calls.",
    surface: "POST /v1/messages · anthropic-beta: thinking-display-updates-2026-08-18 · thinking.display updates",
    steps: ["Send a request with thinking adaptive and display updates."],
    expected: "HTTP 200. Without the beta, updates is rejected as an unknown display value.",
    betas: ["thinking-display-updates-2026-08-18"],
    cost: "low",
    feature: "thinking_display_updates",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["thinking-display-updates-2026-08-18"],
        thinking: { type: "adaptive", display: "updates" } as Anthropic.Beta.BetaThinkingConfigParam,
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("display: updates accepted", res.type === "message");
    },
  }),

  defineProbe({
    id: "TC-BETA-07",
    title: "Per-message effort",
    category: "beta",
    purpose: "Checks changing effort mid-conversation through a system message carrying output_config, which avoids invalidating the prompt cache.",
    surface: "POST /v1/messages · anthropic-beta: mid-conversation-output-config-2026-07-01 · { role: system, content: [], output_config }",
    steps: ["Send a user turn followed by an effort-only system message setting effort low."],
    expected: "HTTP 200.",
    betas: ["mid-conversation-output-config-2026-07-01"],
    cost: "low",
    feature: "per_message_effort",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        model: ctx.model,
        max_tokens: 4096,
        betas: ["mid-conversation-output-config-2026-07-01"],
        messages: [
          { role: "user", content: "Reply with OK." },
          { role: "system", content: [], output_config: { effort: "low" } },
        ],
      });
      ctx.check("Per-message effort accepted", res.type === "message", excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-BETA-08",
    title: "Turn-scoped system message (clear_at)",
    category: "beta",
    purpose: "Checks a mid-conversation system message that applies for one turn only, used for per-turn reminders.",
    surface: "POST /v1/messages · anthropic-beta: mid-conversation-system-clear-at-2026-08-21 · clear_at: next_user_message",
    steps: ["Send a user turn followed by a system message with clear_at next_user_message."],
    expected: "HTTP 200 with a reply that follows the instruction.",
    betas: ["mid-conversation-system-clear-at-2026-08-21"],
    cost: "low",
    feature: "clear_at",
    async run(ctx) {
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["mid-conversation-system-clear-at-2026-08-21"],
        messages: [
          { role: "user", content: "Describe the ocean." },
          { role: "system", content: "Answer in exactly three words.", clear_at: "next_user_message" },
        ],
      });
      ctx.check("clear_at system message accepted", res.type === "message");
      ctx.advise("Reply follows it (about three words)", textOf(res).trim().split(/\s+/).length <= 5, excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-BETA-09",
    title: "Server-side refusal fallbacks",
    category: "beta",
    purpose: "Checks the server-side fallback parameter, which re-runs a refused request on a fallback model inside the same call. Anthropic API only; on other platforms the SDK's client-side middleware does this instead.",
    surface: "POST /v1/messages · anthropic-beta: server-side-fallback-2026-07-01 · fallbacks: default",
    steps: ["Send an ordinary request with fallbacks default."],
    expected: "HTTP 200 (no refusal is expected for an ordinary prompt; this verifies the parameter is accepted).",
    betas: ["server-side-fallback-2026-07-01"],
    cost: "low",
    feature: "server_fallbacks",
    async run(ctx) {
      const params = { ...base(ctx), betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", messages: [{ role: "user", content: "Reply with OK." }] };
      const res = await ctx.client.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
      ctx.check("fallbacks: default accepted", res.type === "message", String(res.stop_reason));
    },
  }),

  defineProbe({
    id: "TC-BETA-10",
    title: "MCP connector",
    category: "beta",
    purpose: "Checks the MCP connector, where Anthropic's servers connect to a remote MCP server on the model's behalf. Needs an MCP server URL that Anthropic can reach; skipped without one.",
    surface: "POST /v1/messages · anthropic-beta: mcp-client-2025-11-20 · mcp_servers + mcp_toolset",
    steps: ["Declare the configured MCP server and its toolset.", "Ask the model to list the server's tools."],
    expected: "HTTP 200, ideally with MCP tool use or a list of the server's tools.",
    betas: ["mcp-client-2025-11-20"],
    cost: "low",
    feature: "mcp_connector",
    requires: ["mcpServerUrl"],
    async run(ctx) {
      const url = ctx.profile.mcpServerUrl;
      if (!url) throw new SkipProbe("No MCP server URL configured. Set one in the target's advanced settings to run this case.");
      const name = ctx.profile.mcpServerName || "probe-server";
      const res = await ctx.client.beta.messages.create({
        ...base(ctx),
        betas: ["mcp-client-2025-11-20"],
        mcp_servers: [{ type: "url", url, name }],
        tools: [{ type: "mcp_toolset", mcp_server_name: name }],
        messages: [{ role: "user", content: "List the tools available to you from the MCP server, by name." }],
      });
      ctx.check("MCP connector request accepted", res.type === "message");
      const types = (res.content as { type: string }[]).map((b) => b.type);
      ctx.advise("Model used or listed MCP tools", types.some((t) => t.startsWith("mcp_")) || textOf(res).length > 0, types.join(", "));
    },
  }),

  defineProbe({
    id: "TC-BETA-11",
    title: "Agent Skills (Anthropic xlsx skill)",
    category: "beta",
    purpose:
      "Checks Agent Skills on the Messages API: an Anthropic-managed skill loaded into a code execution container produces a file. Comparatively expensive (container time plus generation), so opt-in. Generated files are deleted afterwards. Anthropic API only.",
    surface: "POST /v1/messages · anthropic-beta: code-execution-2025-08-25 · container.skills · code_execution_20260521",
    steps: ["Load the xlsx skill into a container.", "Ask for a one-cell spreadsheet.", "Resume paused turns.", "Delete any files produced."],
    expected: "Code execution runs and a file is produced.",
    betas: ["code-execution-2025-08-25"],
    cost: "high",
    optIn: true,
    feature: "agent_skills",
    async run(ctx) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "Create a spreadsheet named probe.xlsx with the value 42 in cell A1." }];
      const all: Anthropic.Beta.BetaMessage[] = [];
      for (let i = 0; i < 4; i++) {
        if (i) ctx.label(`resume after pause_turn #${i}`);
        const res = await ctx.client.beta.messages.create({
          ...base(ctx, { maxTokens: 16000 }),
          betas: ["code-execution-2025-08-25"],
          container: { skills: [{ type: "anthropic", skill_id: "xlsx", version: "latest" }] },
          tools: [{ type: "code_execution_20260521", name: "code_execution" }],
          messages,
        });
        all.push(res);
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });
      }
      const blocks = all.flatMap((m) => m.content as unknown as { type: string; content?: unknown }[]);
      const ran = blocks.filter((b) => b.type.endsWith("code_execution_tool_result"));
      ctx.check("Code execution ran in the skill container", ran.length > 0, `${ran.length} execution block(s)`);
      const fileIds = JSON.stringify(blocks).match(/file_[A-Za-z0-9]+/g) ?? [];
      const unique = [...new Set(fileIds)];
      ctx.advise("A file was produced", unique.length > 0, unique.join(", ") || "none");
      for (const id of unique) {
        ctx.label(`delete generated ${id}`);
        await ctx.client.files.delete(id).catch(() => undefined);
      }
    },
  }),
];
