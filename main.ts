const RAW_INDEX_URL = "https://raw.githubusercontent.com/delitamakanda/faq-worker/main/static/faq_index.json";

let INDEX: Array<{ id:number; q:string; a:string; embedding:number[] }> = [];
let ETAG: string | null = null;

async function loadIndex(force = false) {
  const headers: Record<string,string> = {};
  if (ETAG && !force) headers["If-None-Match"] = ETAG;

  const r = await fetch(RAW_INDEX_URL, { headers });
  if (r.status === 304) return; // rien à faire
  if (!r.ok) throw new Error(`Fetch index failed: ${r.status}`);

  INDEX = await r.json();
  ETAG = r.headers.get("etag");
  console.log(`Index loaded: ${INDEX.length} items, etag=${ETAG ?? "none"}`);
}

// cold start
await loadIndex();

setInterval(() => loadIndex().catch(()=>{}), 15 * 60 * 1000);

const ORIGIN = "https://delitamakanda.github.io";

type FaqIndexItem = { id: number; q: string; a: string; embedding: number[] };

import indexJson from "./faq_index.json" assert { type: "json" };
const INDEX = indexJson as FaqIndexItem[];

function headersJSON(status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  };
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, headersJSON().headers);

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), headersJSON(405));
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), headersJSON(400)); }
  const question = (body?.question ?? "").toString().trim();
  if (question.length < 3) return new Response(JSON.stringify({ error: "Question too short" }), headersJSON(400));

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), headersJSON(500));

  // Embedding de la question
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: question })
  });
  if (!embRes.ok) {
    const t = await embRes.text();
    return new Response(JSON.stringify({ error: "Embedding failed", details: t }), headersJSON(500));
  }
  const embJson = await embRes.json();
  const qVec = embJson.data[0].embedding as number[];

  // Top-3 FAQ par similarité
  const top = INDEX
    .map(item => ({ item, score: cosine(qVec, item.embedding) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.item);

  const context = top.map((t,i) => `#${i+1}\nQ: ${t.q}\nA: ${t.a}`).join("\n\n");

  const system = `Tu es un agent FAQ concis pour un portfolio.
Tu NE réponds qu'à partir du contexte fourni. Si l'info n'est pas dedans, dis: "Je n'ai pas cette info pour le moment."
2 à 4 phrases max, ton pro et simple, en français.`;

  const user = `Question: ${question}\n\nContexte FAQ:\n${context}`;

  // Appel Responses API
  const respRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  if (!respRes.ok) {
    const t = await respRes.text();
    return new Response(JSON.stringify({ error: "LLM failed", details: t }), headersJSON(500));
  }
  const respJson = await respRes.json();
  const answer = (respJson as any).output_text ?? "";

  return new Response(JSON.stringify({ answer: String(answer).trim() }), headersJSON(200));
});

