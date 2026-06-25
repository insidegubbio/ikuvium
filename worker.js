/**
 * insidegubbio ai api based on workers
 */

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/([\w-]+\.)?insidegubbio\.com$/

const MONUMENTS_ENDPOINT =
  "https://api.insidegubbio.com/v1/articles/elenco-monumenti"

const DEFAULT_MODEL = "gemini-2.5-flash" // if no var is set

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN_PATTERN.test(origin || "")
    ? origin
    : "https://insidegubbio.com"
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  }
}

function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  })
}

// fetch monuments
async function fetchMonuments() {
  const res = await fetch(MONUMENTS_ENDPOINT, {
    cf: { cacheTtl: 300, cacheEverything: true }, // cloudflare edge cache 5 min
  })
  if (!res.ok) return []

  const data = await res.json()
  const list = Array.isArray(data?.monumenti) ? data.monumenti : []
  const seen = new Set()
  const monuments = []

  for (const m of list) {
    const key = m?.nome
    if (!key || seen.has(key)) continue
    seen.add(key)
    monuments.push({
      nome: m.nome || "Monumento",
      percorso: m.percorso || "",
      valutazione: m.valutazione || "",
      visitabilita: m.visitabilita || "",
      coordinate: {
        lat: m.coordinate?.lat ?? 0,
        lng: m.coordinate?.lng ?? 0,
      },
    })
  }
  return monuments
}

function buildMonumentsContext(monuments) {
  return monuments
    .map((m, i) => {
      const parts = [
        `${i + 1}. ${m.nome}`,
        `coord: ${m.coordinate.lat.toFixed(5)},${m.coordinate.lng.toFixed(5)}`,
        `rilevanza: ${m.valutazione}`,
        `visitabilità: ${m.visitabilita}`,
      ]
      if (m.percorso && m.percorso !== "idem" && m.percorso !== "vedi sopra")
        parts.push(`percorso: ${m.percorso}`)
      return parts.join(" | ")
    })
    .join("\n")
}

// call gemini
async function callGemini(apiKey, model, userPrompt, monuments, systemPromptTemplate) {
  const monumentsContext = buildMonumentsContext(monuments)

  // we will not leak the prompt lol
  const systemInstruction = systemPromptTemplate
    .replace("{{MONUMENTS}}", monumentsContext)

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.4, maxOutputTokens: 5000 },
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    const msg = data?.error?.message || "Errore Gemini sconosciuto"
    throw new Error(msg)
  }

  const parts = data?.candidates?.[0]?.content?.parts || []
  const text = parts
    .map((p) => p.text || "")
    .join("")
    .trim()

  if (!text)
    throw new Error("Risposta vuota da Gemini, riprova.")

  return text
}

// handler
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || ""
    const url = new URL(request.url)

    // preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    // post
    if (request.method === "POST" && url.pathname === "/api/v1/itinerary") {

      // check origin
      if (!ALLOWED_ORIGIN_PATTERN.test(origin)) {
        return jsonResponse({ error: "Origine non autorizzata" }, 403, origin)
      }

      // parse body
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: "Body JSON non valido" }, 400, origin)
      }

      const prompt = (body?.prompt || "").trim()
      if (!prompt) {
        return jsonResponse({ error: "Campo 'prompt' mancante o vuoto" }, 400, origin)
      }

      const apiKey = env.GEMINI_API_KEY
      if (!apiKey) {
        return jsonResponse(
          { error: "Configurazione server mancante (GEMINI_API_KEY)" },
          500,
          origin
        )
      }

      const model = env.GEMINI_MODEL || DEFAULT_MODEL

      const systemPromptTemplate = env.SYSTEM_PROMPT
      if (!systemPromptTemplate) {
        return jsonResponse(
          { error: "Configurazione server mancante (SYSTEM_PROMPT)" },
          500,
          origin
        )
      }

      let monuments, itinerary
      try {
        monuments = await fetchMonuments()
        if (!monuments.length) {
          return jsonResponse(
            { error: "Impossibile recuperare i monumenti. Riprova tra poco." },
            502,
            origin
          )
        }
        itinerary = await callGemini(apiKey, model, prompt, monuments, systemPromptTemplate)
      } catch (err) {
        return jsonResponse({ error: err.message || "Errore interno" }, 502, origin)
      }

      return jsonResponse({ itinerary }, 200, origin)
    }

    // health check
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return jsonResponse({ status: "ok" }, 200, origin)
    }

    return jsonResponse({ error: "Not found" }, 404, origin)
  },
}
