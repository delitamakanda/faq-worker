# faq-worker (API)

Endpoint JSON pour FAQ IA.  
Cherche `faq_index.json` dans le repo portftolio avec cache ETag.

## Déploiement

1. Crée un nouveau projet sur https://dash.deno.com
2. "New Project" → "Import from GitHub" → sélectionne ce repo
3. Dans **Settings → Environment Variables**, ajoute :
   - `OPENAI_API_KEY` = sk-xxxx
   - `RAW_INDEX_URL`  = https://raw.githubusercontent.com/<user>/<repo-pages>/main/static/faq_index.json
   - `ALLOW_ORIGIN`   = https://<user>.github.io (ou "*" pour tester)
4. Deploy → récupère l’URL : `https://dlitamakand-faq-worker-18.deno.dev/`

## Appel

POST `<url-deno>` avec JSON `{ "question": "..." }`.

Réponse : `{ "answer": "..." }`.

## Notes
- L’index est refresh toutes les 15 minutes et à chaque cold start (If-None-Match ETag).
- Modèle embeddings: `text-embedding-3-small`
- Modèle LLM: `gpt-4o-mini`
