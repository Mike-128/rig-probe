import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { defineProbe } from "../types";
import { FILE_CODEWORD } from "../fixtures";
import { base, excerpt, textOf } from "./_util";

export const files = [
  defineProbe({
    id: "TC-FILE-01",
    title: "Files API lifecycle (upload, use, delete)",
    category: "files",
    purpose:
      "Checks the Files API end to end: upload a file once, reference it by file_id in a message, then delete it. Multipart uploads are where gateways most often differ from JSON requests (body size limits, content-type handling). Not offered on Vertex AI.",
    surface: "POST/GET/DELETE /v1/files · client.files.upload/retrieveMetadata/list/delete · document source.type file",
    steps: [
      "Upload a small text file containing an access phrase.",
      "Read its metadata and list files.",
      "Ask the model for the access phrase, referencing the file by file_id.",
      "Delete the file and confirm it is gone.",
    ],
    expected: "Every call succeeds, the answer contains GRANITE-OTTER, and the file is no longer retrievable afterwards.",
    cost: "low",
    feature: "files",
    async run(ctx) {
      const content = `Rig Probe file test. The access phrase is ${FILE_CODEWORD}.`;
      const uploaded = await ctx.client.files.upload({ file: await toFile(Buffer.from(content), "rig-probe.txt", { type: "text/plain" }) });
      ctx.check("File uploaded", uploaded.id.startsWith("file_"), `${uploaded.id}, ${uploaded.size_bytes} bytes`);
      try {
        ctx.label("retrieve metadata");
        const meta = await ctx.client.files.retrieveMetadata(uploaded.id);
        ctx.check("Metadata retrieved", meta.id === uploaded.id, `${meta.filename} (${meta.mime_type})`);
        ctx.label("list");
        const page = await ctx.client.files.list({ limit: 20 });
        ctx.advise("File appears in the list", page.data.some((f) => f.id === uploaded.id), `${page.data.length} files on first page`);
        ctx.label("use in a message");
        const res = await ctx.client.messages.create({
          ...base(ctx),
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "file", file_id: uploaded.id } },
                { type: "text", text: "What is the access phrase in this file? Reply with just the phrase." },
              ],
            },
          ],
        });
        ctx.check(`Model read the file (${FILE_CODEWORD})`, textOf(res).includes(FILE_CODEWORD), excerpt(textOf(res)));
      } finally {
        ctx.label("delete");
        const del = await ctx.client.files.delete(uploaded.id);
        ctx.check("File deleted", del.id === uploaded.id);
      }
      ctx.label("confirm deletion");
      try {
        await ctx.client.files.retrieveMetadata(uploaded.id);
        ctx.advise("Deleted file is no longer retrievable", false, "still retrievable");
      } catch (err) {
        ctx.advise("Deleted file is no longer retrievable", err instanceof Anthropic.NotFoundError, err instanceof Error ? err.constructor.name : String(err));
      }
    },
  }),
];
