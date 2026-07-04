# ikuvium

cloudflare worker che espone un endpoint di intelligenza artificiale per generare itinerari turistici tra i monumenti di gubbio. usa gemini via google ai studio e recupera i dati dei monumenti dall'api principale di insidegubbio.

## architettura

```
client (framer)
    |
    v
cloudflare worker  (questo repo)
    |         |
    v         v
gemini api    api.insidegubbio.com/v1/articles/elenco-monumenti
```

il worker riceve il prompt dell'utente, recupera la lista aggiornata dei monumenti, costruisce un contesto compatto e chiama gemini in streaming, restituendo la risposta chunk per chunk via server-sent events.

## endpoint

### `POST /api/v1/itinerary`

genera un itinerario in streaming.

**body json:**
```json
{ "prompt": "suggerisci un percorso a piedi nel centro storico" }
```

**risposta:** `text/event-stream`

ogni chunk ha la forma:
```
data: {"chunk": "testo..."}
```

la sequenza termina con:
```
data: [DONE]
```

in caso di errore:
```
data: {"error": "messaggio di errore"}
```

### `GET /api/v1/health`

restituisce `{"status": "ok"}`. utile per verificare che il worker sia attivo.

## origini autorizzate

solo le seguenti origini possono chiamare `/api/v1/itinerary`:

- `https://insidegubbio.com`
- `https://www.insidegubbio.com`
- sottodomini di `insidegubbio.framer.ai`

richieste da altre origini ricevono un `403 origine non autorizzata`. richieste senza header `origin` (curl, script server-side) passano senza restrizioni.

## variabili d'ambiente (wrangler secrets)

| variabile | descrizione |
|---|---|
| `GEMINI_API_KEY` | chiave api di google ai studio |
| `GEMINI_MODEL` | modello da usare (default: `gemini-2.5-flash`) |
| `SYSTEM_PROMPT` | prompt di sistema con il placeholder `{{MONUMENTS}}` |

configurate via:
```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put GEMINI_MODEL
wrangler secret put SYSTEM_PROMPT
```

## kv binding (opzionale)

il worker supporta un kv namespace chiamato `MONUMENTS_KV` per cachare la lista dei monumenti e ridurre le chiamate all'api esterna.

- ttl in memoria: 5 minuti
- ttl su kv: 10 minuti

se il binding non e' configurato, i monumenti vengono recuperati dall'api a ogni richiesta fredda.

## caching dei monumenti

il worker usa una cache a tre livelli:

1. memoria del worker (piu' veloce, resettata a ogni nuovo isolate)
2. kv namespace (persiste tra isolate, ttl 10 min)
3. fetch diretto all'api (fallback, timeout 5s)

i monumenti non piu' esistenti, senza coordinate o non agibili vengono filtrati prima di essere passati a gemini. i percorsi di accesso non vengono inclusi nel contesto per ridurre i token inviati al modello.

## timeout

| operazione | timeout |
|---|---|
| fetch monumenti | 5 secondi |
| risposta gemini (streaming) | 55 secondi |

nota: il piano gratuito di cloudflare workers ha un limite di wall-clock time di 30 secondi. per evitare risposte troncate si consiglia il piano paid ($5/mese).

## sviluppo locale

```bash
npm install
wrangler dev
```

per il deploy:
```bash
wrangler deploy
```

## dipendenze

nessuna dipendenza npm. il worker usa solo le api native di cloudflare workers e fetch standard.
