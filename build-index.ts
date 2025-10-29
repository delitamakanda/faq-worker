const API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!API_KEY) throw new Error("Missing OPENAI_API_KEY");

const IN = "./static/faq.json";
const OUT = "./static/faq_index.json";

type Faq = { q: string; a: string };
type FaqIndexItem = { id: number; q: string; a: string; embedding: number[] };

const entries: Faq[] = JSON.parse(await Deno.readTextFile(IN));
const texts = entries.map(e => `Q: ${e.q}\nA: ${e.a}`);

const r = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "text-embedding-3-small",
    input: texts,
  }),
});
if (!r.ok) {
  console.error("Embedding request failed:", await r.text());
  Deno.exit(1);
}
const data = await r.json();

const index: FaqIndexItem[] = data.data.map((d: any, i: number) => ({
  id: i,
  q: entries[i].q,
  a: entries[i].a,
  embedding: d.embedding as number[],
}));

await Deno.writeTextFile(OUT, JSON.stringify(index, null, 2));
console.log(`✓ Index généré: ${OUT} (${index.length} items)`);
