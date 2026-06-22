# Busca por voz (Alexa → Stremio)

Pipeline: você fala numa Alexa (controle da Fire TV ou Echo) → skill custom →
Cloudflare Worker (nuvem) → o app NexoTV na Fire TV puxa a busca → abre o Stremio
via deep link `stremio:///search?search=...`.

> Defina seu próprio segredo. NÃO comite valores reais.
> Segredo compartilhado (exemplo): `CHANGE_ME_SHARED_SECRET`

## 1. Cloudflare Worker (grátis, sem cartão)
1. Conta em https://dash.cloudflare.com/sign-up
2. Workers & Pages → Create Worker (ex.: `nexotv-voice`) → Deploy → anote a URL
3. Edit code → cole `worker.js` → Deploy
4. KV → Create namespace `voice`
5. Worker → Settings → Bindings → KV namespace: Variable `VOICE_KV` → `voice`
6. Worker → Settings → Variables → `SHARED_SECRET` = seu segredo

Teste: `https://SEU-WORKER.workers.dev/set?secret=SEU_SEGREDO&q=teste` → `{"ok":true,...}`

## 2. App NexoTV (Fire TV)
No `main.js` defina (ou via env): `CLOUD_BRIDGE_URL` = URL do Worker,
`CLOUD_BRIDGE_SECRET` = mesmo `SHARED_SECRET`.

## 3. Alexa Skill (developer.amazon.com/alexa/console/ask)
- Mesma conta Amazon da Fire TV → Create Skill → idioma **Português (BR)** → Custom / Provision your own
- Invocation: um nome de 2+ palavras, sem marca (ex.: `minha telinha`)
- Interaction Model → JSON Editor → cole `interaction-model-ptBR.json` → Save → Build Skill
- Endpoint → HTTPS → URL do Worker → SSL: "sub-domain of a domain that has a wildcard certificate"
- Test → Development

## Frases (Fire TV exige começar pela abertura)
- "Alexa, abrir minha telinha e procurar [filme/série/canal]"
- "Alexa, abrir minha telinha" → (pergunta) → diga o título (no Echo)

## Notas / limites (Fire OS)
- Fire TV não mantém sessão de skill: use a forma "uma tacada" (com verbo).
- Echo Show: o modo conversa pode funcionar melhor; mas a busca universal dele compete.
- Nome de invocação não pode ser marca registrada nem 1 letra/sigla sem pontos.
