import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { defineProbe } from "../types";
import { base, excerpt, textOf } from "./_util";

export const structured = [
  defineProbe({
    id: "TC-STRUCT-01",
    title: "Structured output with the SDK parse helper",
    category: "structured",
    purpose: "Checks the recommended way to get typed JSON: messages.parse() with a Zod schema, which constrains the output and validates it client-side.",
    surface: "POST /v1/messages · client.messages.parse() · output_config.format (zodOutputFormat)",
    steps: ["Define a Zod schema with city, country, and is_capital.", "Ask for facts about Paris via messages.parse()."],
    expected: "parsed_output is non-null and validates: city Paris, is_capital true.",
    cost: "low",
    feature: "structured_outputs",
    async run(ctx) {
      const City = z.object({ city: z.string(), country: z.string(), is_capital: z.boolean() });
      const b = base(ctx);
      const res = await ctx.client.messages.parse({
        ...b,
        output_config: { ...(b.output_config ?? {}), format: zodOutputFormat(City) },
        messages: [{ role: "user", content: "Give me basic facts about Paris." }],
      });
      const out = res.parsed_output;
      ctx.check("parsed_output is present", out != null, excerpt(textOf(res)));
      if (!out) return;
      ctx.check("Validated fields are correct", /paris/i.test(out.city) && out.is_capital === true, JSON.stringify(out));
    },
  }),

  defineProbe({
    id: "TC-STRUCT-02",
    title: "Structured output with a raw JSON schema",
    category: "structured",
    purpose: "Checks output_config.format with a hand-written JSON schema on messages.create(), for applications not using Zod.",
    surface: "POST /v1/messages · output_config.format { type: json_schema }",
    steps: ["Send a JSON schema requiring name and population fields.", "Parse the text response as JSON."],
    expected: "The response text parses as JSON with exactly the required fields and correct types.",
    cost: "low",
    feature: "structured_outputs",
    async run(ctx) {
      const b = base(ctx);
      const res = await ctx.client.messages.create({
        ...b,
        output_config: {
          ...(b.output_config ?? {}),
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { name: { type: "string" }, population_millions: { type: "number" } },
              required: ["name", "population_millions"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: "Name the most populous city in Japan and its approximate population in millions." }],
      });
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(textOf(res));
      } catch {
        /* reported below */
      }
      ctx.check("Response is valid JSON", parsed !== undefined, excerpt(textOf(res)));
      if (!parsed) return;
      ctx.check("Fields match the schema", typeof parsed.name === "string" && typeof parsed.population_millions === "number" && Object.keys(parsed).length === 2, JSON.stringify(parsed));
    },
  }),
];
