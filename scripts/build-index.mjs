import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const IN = resolve("static/faq.json");
const OUT = resolve("static/faq_index.json");
const MODEL = "text-embedding-3-small";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

async function main() {
  if (!existsSync(IN)) {
    console.error(`❌ Input not found: ${IN}`);
    process.exit(1);
  }

  /** @type {{q:string,a:string}[]} */
  let entries;
  try {
    entries = JSON.parse(await readFile(IN, "utf8"));
  } catch (e) {
    console.error(`❌ Cannot parse ${IN}:`, e?.message || e);
    process.exit(1);
  }

  entries = (entries || []).filter(e => isNonEmptyString(e?.q) && isNonEmptyString(e?.a));
  if (entries.length === 0) {
    console.error("❌ FAQ is empty or invalid. Expecting array of { q, a }.");
    process.exit(1);
  }

  const inputs = entries.map(e => `Q: ${e.q}\nA: ${e.a}`);

  // Appel Embeddings
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: inputs,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("❌ Embeddings API failed:", t);
    process.exit(1);
  }

  const json = await r.json();
  if (!Array.isArray(json?.data) || json.data.length !== entries.length) {
    console.error("❌ Unexpected embeddings response shape/length.");
    process.exit(1);
  }

  const index = json.data.map((d, i) => ({
    id: i,
    q: entries[i].q,
    a: entries[i].a,
    embedding: d.embedding,
  }));

  await writeFile(OUT, JSON.stringify(index, null, 2), "utf8");
  console.log(`✓ Wrote ${index.length} vectors -> ${OUT}`);
}

main().catch((e) => {
  console.error("❌ build-index failed:", e?.message || e);
  process.exit(1);
});
