type FaqIndexItem = { id: number; q: string; a: string; embedding: number[] };

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const RAW_INDEX_URL  = Deno.env.get("RAW_INDEX_URL")  ?? "";
const ALLOW_ORIGIN   = Deno.env.get("ALLOW_ORIGIN")   ?? "*";

if (!OPENAI_API_KEY) throw new Error("Missing env OPENAI_API_KEY");
if (!RAW_INDEX_URL)  throw new Error("Missing env RAW_INDEX_URL");

let INDEX: FaqIndexItem[] = [];
let ETAG: string | null = null;

// --- utils ---
function headersJSON(status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    },
  };
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? (dot / denom) : 0;
}

// Charge/refresh l'index avec ETag
async function loadIndex(force = false) {
  const hdrs: Record<string,string> = {};
  if (ETAG && !force) hdrs["If-None-Match"] = ETAG;
  const r = await fetch(RAW_INDEX_URL, { headers: hdrs });
  if (r.status === 304) return; // pas de changement
  if (!r.ok) throw new Error(`Fetch index failed: ${r.status} ${r.statusText}`);
  INDEX = await r.json();
  ETAG = r.headers.get("etag");
  console.log(`Index loaded: ${INDEX.length} items (etag=${ETAG ?? "none"})`);
}

// Cold start: charge l'index
await loadIndex().catch((e) => {
  console.error("Initial index load failed:", e);
  // on laisse démarrer quand même; première requête échouera proprement
});

// Refresh régulier (toutes les 15 minutes)
setInterval(() => { loadIndex().catch(()=>{}); }, 15 * 60 * 1000);

// --- mini rate-limit en mémoire par IP (fenêtre 60s) ---
const RL: Map<string, number[]> = new Map();
function checkRateLimit(ip: string, limit = 60, windowMs = 60_000): string | null {
  const now = Date.now();
  const arr = (RL.get(ip) ?? []).filter(ts => now - ts < windowMs);
  if (arr.length >= limit) return "Trop de requêtes, réessaie dans une minute.";
  arr.push(now); RL.set(ip, arr);
  return null;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { headers: headersJSON().headers });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), headersJSON(405));
  }

  // Rate-limit basique
  const ip = req.headers.get("x-real-ip")
         ?? req.headers.get("cf-connecting-ip")
         ?? "anon";
  const rl = checkRateLimit(ip);
  if (rl) return new Response(JSON.stringify({ error: rl }), headersJSON(429));

  // S'assure que l'index est chargé
  if (!INDEX.length) {
    try { await loadIndex(true); } catch {}
  }
  if (!INDEX.length) {
    return new Response(JSON.stringify({ error: "FAQ index unavailable" }), headersJSON(503));
  }

  // Parse JSON
  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), headersJSON(400)); }

  const question = (body?.question ?? "").toString().trim();
  if (question.length < 3) {
    return new Response(JSON.stringify({ error: "Question trop courte" }), headersJSON(400));
  }

  // Embedding question
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: question })
  });
  if (!embRes.ok) {
    const t = await embRes.text();
    return new Response(JSON.stringify({ error: "Embedding failed", details: t }), headersJSON(500));
  }
  const embJson = await embRes.json();
  const qVec = embJson.data?.[0]?.embedding as number[] | undefined;
  if (!qVec) return new Response(JSON.stringify({ error: "Embedding shape error" }), headersJSON(500));

  // Top-3
  const top = INDEX
    .map(item => ({ item, score: cosine(qVec, item.embedding) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.item);

  const context = top.map((t,i) => `#${i+1}\nQ: ${t.q}\nA: ${t.a}`).join("\n\n");

  const system = `Tu es un agent FAQ concis pour un portfolio.
Tu NE réponds qu'à partir du contexte fourni. Si l'info n'est pas dedans, dis: "Je n'ai pas cette info pour le moment."
2 à 4 phrases max, ton pro et simple, dans la langue de la question.`;

  const user = `Question: ${question}\n\nContexte FAQ:\n${context}`;

  // LLM
  const respRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
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
