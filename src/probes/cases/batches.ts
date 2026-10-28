import Anthropic from "@anthropic-ai/sdk";
import { defineProbe } from "../types";
import { base, excerpt } from "./_util";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export const batches = [
  defineProbe({
    id: "TC-BATCH-01",
    title: "Message Batches lifecycle (create, retrieve, list, cancel)",
    category: "batches",
    purpose: "Checks the batch endpoints are routed and behave: a batch can be created, read back, listed, and canceled. Fast, because it cancels instead of waiting. Not offered on Vertex AI.",
    surface: "POST/GET /v1/messages/batches · client.messages.batches.create/retrieve/list/cancel",
    steps: ["Create a one-request batch.", "Retrieve it by ID.", "List batches.", "Cancel it."],
    expected: "Each call succeeds; after cancel the batch is canceling or already ended.",
    cost: "low",
    feature: "batches",
    async run(ctx) {
      const created = await ctx.client.messages.batches.create({
        requests: [{ custom_id: "rig-probe-1", params: { model: ctx.model, max_tokens: 64, messages: [{ role: "user", content: "Reply with OK." }] } }],
      });
      ctx.check("Batch created", created.id.startsWith("msgbatch_"), created.id);
      ctx.label("retrieve");
      const got = await ctx.client.messages.batches.retrieve(created.id);
      ctx.check("Batch retrieved by ID", got.id === created.id, got.processing_status);
      ctx.label("list");
      const page = await ctx.client.messages.batches.list({ limit: 20 });
      ctx.advise("Batch appears in the list", page.data.some((b) => b.id === created.id), `${page.data.length} batches on first page`);
      ctx.label("cancel");
      try {
        const canceled = await ctx.client.messages.batches.cancel(created.id);
        ctx.check("Cancel accepted", ["canceling", "ended"].includes(canceled.processing_status), canceled.processing_status);
      } catch (err) {
        if (!(err instanceof Anthropic.APIError) || (err.status !== 409 && err.status !== 400)) throw err;
        ctx.label("retrieve after cancel conflict");
        const after = await ctx.client.messages.batches.retrieve(created.id);
        ctx.check("Batch already finished before cancel", after.processing_status === "ended", `${after.processing_status}; cancel said ${excerpt(err.message)}`);
      }
    },
  }),

  defineProbe({
    id: "TC-BATCH-02",
    title: "Message Batch completes and returns results",
    category: "batches",
    purpose: "Checks a batch runs to completion and its results can be streamed back. Slow: batches usually finish within minutes but can take far longer, so this is opt-in and bounded by the batch timeout setting.",
    surface: "POST/GET /v1/messages/batches · client.messages.batches.create/retrieve/results",
    steps: ["Create a one-request batch.", "Poll every 10 seconds until it ends or the timeout passes.", "Read the results."],
    expected: "The batch ends and its one result succeeded with a text reply.",
    cost: "low",
    optIn: true,
    feature: "batches",
    async run(ctx) {
      const created = await ctx.client.messages.batches.create({
        requests: [{ custom_id: "rig-probe-complete", params: { ...base(ctx, { maxTokens: 1024 }), messages: [{ role: "user", content: "Reply with exactly: BATCH-OK" }] } }],
      });
      ctx.check("Batch created", created.id.startsWith("msgbatch_"), created.id);
      const deadline = Date.now() + ctx.profile.batchTimeoutSec * 1000;
      let status = created.processing_status;
      let polls = 0;
      while (status !== "ended" && Date.now() < deadline && !ctx.signal.aborted) {
        await sleep(10_000, ctx.signal);
        ctx.label(`poll ${++polls}`);
        status = (await ctx.client.messages.batches.retrieve(created.id)).processing_status;
      }
      if (status !== "ended") {
        ctx.label("cancel after timeout");
        await ctx.client.messages.batches.cancel(created.id).catch(() => undefined);
        ctx.advise(`Batch finished within ${ctx.profile.batchTimeoutSec} s`, false, `still ${status} after ${polls} polls`);
        ctx.note("Batches can take up to 24 hours. A slow batch is not a gateway fault; raise the batch timeout to wait longer.");
        return;
      }
      ctx.label("results");
      const results: Anthropic.Messages.MessageBatchIndividualResponse[] = [];
      for await (const r of await ctx.client.messages.batches.results(created.id)) results.push(r);
      const ok = results.find((r) => r.result.type === "succeeded");
      ctx.check("Result succeeded", Boolean(ok), results.map((r) => r.result.type).join(", "));
      if (ok?.result.type === "succeeded") {
        const text = ok.result.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        ctx.advise("Result text is BATCH-OK", text.includes("BATCH-OK"), excerpt(text));
      }
      ctx.fact("batchPolls", polls);
    },
  }),
];
