import { deflateSync } from "node:zlib";

/**
 * Test inputs generated in code, so the tool has no binary assets and every input is reproducible
 * from its source. Each carries a fact the model can only know by reading the input.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-color RGB PNG. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(rgb, y * row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const PDF_CODEWORD = "PELICAN-42";

/** A one-page PDF whose only content is a sentence containing PDF_CODEWORD. Offsets are computed, not hand-written. */
export function codewordPdf(): Buffer {
  const text = `The secret codeword is ${PDF_CODEWORD}.`;
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const CITATION_DOC = {
  title: "Rig Probe facility note",
  text: [
    "The Rig Probe test facility is located in Reykjavik and was opened in 2019.",
    "It runs conformance checks against API gateways every night.",
    "Its mascot is a puffin named Bolli.",
  ].join(" "),
  answer: "Reykjavik",
};

export const FILE_CODEWORD = "GRANITE-OTTER";

const WORDS = ["amber", "basalt", "cobalt", "dune", "ember", "fjord", "glacier", "harbor", "iris", "juniper", "kelp", "lagoon", "meadow", "nimbus", "obsidian", "prairie"];

/**
 * A deterministic reference text long enough to clear the model's prompt-cache minimum. The nonce
 * goes first so each run writes a fresh cache entry rather than reading a previous run's.
 */
export function cachePrefix(minTokens: number, nonce: string): string {
  // Each line is roughly 14 tokens. Aim for about 1.6x the minimum so tokenizer variance can't
  // leave the prefix just short of it.
  const lines = Math.ceil((minTokens * 1.6) / 14);
  const body: string[] = [`Run reference ${nonce}. The following is a fixed catalogue used to test prompt caching.`];
  for (let i = 1; i <= lines; i++) {
    body.push(`Entry ${i}: the ${WORDS[i % WORDS.length]} register holds value ${(i * 7919) % 10007} for slot ${i}.`);
  }
  return body.join("\n");
}
