# ikuvium

cloudflare worker che espone un endpoint di intelligenza artificiale per generare itinerari turistici tra i monumenti di gubbio. usa gemini via google ai studio e recupera i dati dei monumenti dall'api principale di insidegubbio.

## architettura

```
client (framer)
    |
    v
cloudflare worker  (questo repo)
    |         |                              |
    v         v                              v
gemini api   console.insidegubbio.com   graphhopper.insidegubbio.com
(pool)     /v2/articles/elenco-monumenti  (routing a piedi)
```

il worker riceve il prompt dell'utente, recupera la lista aggiornata dei monumenti, costruisce un contesto compatto e chiama gemini in streaming, restituendo la risposta chunk per chunk via server-sent events. al termine dello streaming, se gemini ha prodotto un elenco strutturato di poi, il worker calcola il percorso pedonale via graphhopper, genera un file gpx e lo salva su kv.

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
data: {"chunk": "testo accumulato finora..."}
```

i pensieri del modello (thinking) vengono inviati separatamente:
```
data: {"thinking": "testo del ragionamento..."}
```

quando il percorso gpx è pronto:
```
data: {"routeReady": true, "routeId": "abc123def456"}
```

la sequenza termina con:
```
data: [DONE]
```

in caso di errore:
```
data: {"error": "messaggio di errore"}
```

### `GET /api/v1/route/:id`

restituisce i metadati di un percorso salvato in formato json.

```json
{
  "id": "abc123def456",
  "title": "Percorso centro storico",
  "description": "...",
  "gpxUrl": "https://ikuvium.insidegubbio.com/api/v1/route/abc123def456.gpx",
  "pois": [
    {
      "index": 1,
      "name": "Cattedrale di Gubbio",
      "link": "https://www.insidegubbio.com/...",
      "pinUrl": "https://vassallo.insidegubbio.com/svg/pin/1.svg",
      "lat": 43.3567,
      "lon": 12.5779
    }
  ]
}
```

### `GET /api/v1/route/:id.gpx`

restituisce direttamente il file gpx del percorso, con waypoint numerati e traccia pedonale.

### `GET /api/v1/health`

restituisce `{"status": "ok"}`, semplice uptime

## variabili d'ambiente (wrangler secrets)

| variabile | descrizione |
|---|---|
| `GEMINI_API_KEYS` | chiavi api di google ai studio separate da virgola (con fallback automatico su quota esaurita) |
| `GEMINI_API_KEY` | alternativa singola a `GEMINI_API_KEYS` |
| `GEMINI_MODEL` | modello da usare (default: `gemini-3.5-flash-lite`) |
| `SYSTEM_PROMPT` | prompt di sistema con il placeholder `{{MONUMENTS}}` |

configurate via:
```bash
wrangler secret put GEMINI_API_KEYS
wrangler secret put GEMINI_MODEL
wrangler secret put SYSTEM_PROMPT
```

se si fornisce `GEMINI_API_KEYS`, le chiavi vengono mescolate casualmente ad ogni richiesta e in caso di risposta `429` o `403` si passa automaticamente alla chiave successiva.

## kv bindings

il worker usa due kv namespace:

| binding | descrizione | ttl |
|---|---|---|
| `MONUMENTS_KV` | cache della lista monumenti | 10 minuti |
| `ROUTES_KV` | percorsi gpx generati | 90 giorni |

entrambi sono opzionali ma consigliati. senza `MONUMENTS_KV` i monumenti vengono recuperati dall'api a ogni richiesta fredda. 
senza `ROUTES_KV` i percorsi non vengono salvati e l'endpoint `/api/v1/route/:id` non funziona.

## tempi

| operazione | timeout |
|---|---|
| fetch monumenti | 5 secondi |
| fetch gpx via graphhopper | 20 secondi |
| risposta gemini (streaming) | 55 secondi |

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
