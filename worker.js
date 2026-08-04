const ALLOWED_ORIGIN_PATTERN =
  /^https?:\/\/(([\w-]+\.)?insidegubbio\.com|([\w-]+\.)?insidegubbio\.framer\.ai)$/

const DEFAULT_MODEL = "gemini-3.1-flash-lite"
const GRAPHHOPPER_BASE = "https://graphhopper.insidegubbio.com"
const POI_BASE_URL = "https://www.insidegubbio.com"
const PIN_BASE_URL = "https://vassallo.insidegubbio.com/svg/pin"

let memCache = null
let memCacheTime = 0
const MEM_TTL = 5 * 60 * 1000
const KV_TTL_SECONDS = 10 * 60
const ROUTE_TTL_SECONDS = 60 * 60 * 24 * 90
const MONUMENTS_FETCH_TIMEOUT = 5000
const GPX_FETCH_TIMEOUT = 20000
const GEMINI_TIMEOUT = 55000
const MAX_OUTPUT_TOKENS = 14000
const THINKING_LEVEL = "low"

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN_PATTERN.test(origin || "")
    ? origin
    : "https://insidegubbio.com"
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  }
}

function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  })
}

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} dopo ${ms}ms`)), ms)
    ),
  ])
}

function makeRouteId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12)
}

function parseCoordinateFromVisitabilita(visitabilita) {
  if (!visitabilita) return null
  const match = visitabilita.match(/(4[0-9]\.[0-9]+)\s*,\s*(1[0-9]\.[0-9]+)/)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lng = parseFloat(match[2])
  if (isNaN(lat) || isNaN(lng)) return null
  return { lat, lng }
}

function parseMonuments(data) {
  const list = Array.isArray(data?.monumenti) ? data.monumenti : []
  if (list.length) {
    console.log("MONUMENT SAMPLE:", JSON.stringify(list[0]))
    console.log("TUTTI I NOMI:", list.map(m => m.nome).join(" | "))
  }
  const seen = new Set()
  const out = []
  for (const m of list) {
    if (!m?.nome || seen.has(m.nome)) continue
    seen.add(m.nome)

    let lat = m.coordinate?.lat ?? m.coordinate?.latitude ?? null
    let lng = m.coordinate?.lng ?? m.coordinate?.lon ?? m.coordinate?.longitude ?? null

    if (lat === null) lat = m.lat ?? m.latitude ?? null
    if (lng === null) lng = m.lng ?? m.lon ?? m.longitude ?? null

    if (lat === null || lng === null) {
      const extracted = parseCoordinateFromVisitabilita(m.visitabilita)
      if (extracted) {
        lat = extracted.lat
        lng = extracted.lng
      }
    }

    if (!lat || !lng) {
      console.warn("COORDINATE MANCANTI:", m.nome)
    }

    out.push({
      nome: m.nome,
      zona: m.zona || m.area || "",
      valutazione: m.valutazione || "",
      visitabilita: (m.visitabilita || "").replace(/\s*-\s*[0-9]+\.[0-9]+\s*,\s*[0-9]+\.[0-9]+/, "").trim(),
      slug: m.slug || m.link || m.url || "",
      coordinate: { lat: lat ?? 0, lng: lng ?? 0 },
    })
  }
  return out
}

async function fetchMonuments(env) {
  const now = Date.now()

  if (memCache && now - memCacheTime < MEM_TTL) return memCache

  if (env.MONUMENTS_KV) {
    try {
      const raw = await env.MONUMENTS_KV.get("monuments")
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.length) {
          memCache = parsed
          memCacheTime = now
          return parsed
        }
      }
    } catch {}
  }

  const res = await withTimeout(
    env.MONUMENTI.fetch(new Request("https://console.insidegubbio.com/v2/articles/elenco-monumenti")),
    MONUMENTS_FETCH_TIMEOUT,
    "Fetch monumenti"
  )

  if (!res.ok) {
    console.error("Monumenti fetch failed:", res.status, (await res.text()).slice(0, 200))
    return memCache || []
  }

  const data = await res.json()
  const monuments = parseMonuments(data)
  if (!monuments.length) return memCache || []

  memCache = monuments
  memCacheTime = now

  if (env.MONUMENTS_KV) {
    env.MONUMENTS_KV.put("monuments", JSON.stringify(monuments), {
      expirationTtl: KV_TTL_SECONDS,
    }).catch(() => {})
  }

  return monuments
}

function buildMonumentsContext(monuments) {
  return monuments
    .filter(m => {
      if (!m.coordinate?.lat) return false
      if (/non più esistente|non agibile|ruderi/.test(m.visitabilita)) return false
      return true
    })
    .map((m, i) =>
      `${i + 1}. ${m.nome} | zona: ${m.zona || "centro_medio"} | coord: ${m.coordinate.lat.toFixed(4)},${m.coordinate.lng.toFixed(4)} | rilevanza: ${m.valutazione} | visitabilità: ${m.visitabilita} | link: ${m.slug || "n/d"}`
    )
    .join("\n")
}

function normalizeMonumentName(str) {
  return (str || "")
    .trim()
    .toLowerCase()
    .replace(/\bquaranta\b/g, "40")
    .replace(/\bventi\b/g, "20")
    .replace(/\bdieci\b/g, "10")
    .replace(/\bcinquanta\b/g, "50")
    .replace(/\blogge\b/g, "loggia")
    .replace(/\bduomo\b/g, "cattedrale")
    .replace(/\bss\.\s*/g, "santi ")
    .replace(/\bs\.\s*/g, "san ")
    .replace(/\bst\.\s*/g, "santa ")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\b(di|del|della|dei|degli|delle|il|la|le|lo|i|gli)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function findMonumentByName(monuments, nome) {
  const target = normalizeMonumentName(nome)

  const exact = monuments.find(m => normalizeMonumentName(m.nome) === target)
  if (exact) return exact

  const partial = monuments.find(m => {
    const mn = normalizeMonumentName(m.nome)
    return mn.includes(target) || target.includes(mn)
  })
  if (partial) return partial

  const targetWords = target.split(" ").filter(w => w.length > 3)
  if (targetWords.length >= 2) {
    const best = monuments.find(m => {
      const mnWords = normalizeMonumentName(m.nome).split(" ")
      const matches = targetWords.filter(w => mnWords.includes(w))
      return matches.length >= 2
    })
    if (best) return best
  }

  console.warn(`NON TROVATO: "${nome}" -> "${target}"`)
  return null
}

function poiLink(slug) {
  if (!slug) return null
  if (slug.startsWith("http")) return slug
  return `${POI_BASE_URL}/${slug.replace(/^\//, "")}`
}

async function fetchGraphHopperRoute(pois) {
  const params = new URLSearchParams()
  for (const p of pois) {
    params.append("point", `${p.lat},${p.lon}`)
  }
  params.set("profile", "foot")
  params.set("points_encoded", "false")

  const url = `${GRAPHHOPPER_BASE}/route?${params.toString()}`
  console.log("GraphHopper URL:", url)

  const res = await withTimeout(
    fetch(url, { headers: { Accept: "application/json" } }),
    GPX_FETCH_TIMEOUT,
    "GraphHopper route"
  )

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GraphHopper ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  const path = data?.paths?.[0]
  if (!path) throw new Error("GraphHopper: nessun percorso trovato")

  return path.points?.coordinates || []
}

function buildGpx(routeTitle, routeDescription, pois, trackCoords) {
  const escape = s => (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

  const wpts = pois.map((p, i) => {
    const link = poiLink(p.slug)
    const pinUrl = `${PIN_BASE_URL}/${Math.min(i + 1, 15)}.svg`
    return `  <wpt lat="${p.lat}" lon="${p.lon}">
    <name>${escape(p.nome)}</name>
    <sym>${escape(pinUrl)}</sym>${link ? `\n    <link href="${escape(link)}"><text>${escape(p.nome)}</text></link>` : ""}
  </wpt>`
  }).join("\n")

  const trkpts = trackCoords.map(([lng, lat, ele]) =>
    `      <trkpt lat="${lat}" lon="${lng}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ""}</trkpt>`
  ).join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ikuvium" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escape(routeTitle)}</name>
    <desc>${escape(routeDescription)}</desc>
  </metadata>
${wpts}
  <trk>
    <name>${escape(routeTitle)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`
}

async function generateRouteGpx(routeTitle, routeDescription, pois) {
  const trackCoords = await fetchGraphHopperRoute(pois)
  return buildGpx(routeTitle, routeDescription, pois, trackCoords)
}

async function saveRoute(env, routeId, data) {
  if (!env.ROUTES_KV) return
  await env.ROUTES_KV.put(`route:${routeId}`, JSON.stringify(data), {
    expirationTtl: ROUTE_TTL_SECONDS,
  })
}

async function loadRoute(env, routeId) {
  if (!env.ROUTES_KV) return null
  const raw = await env.ROUTES_KV.get(`route:${routeId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

async function streamGemini(env, apiKey, model, userPrompt, monuments, systemPromptTemplate, origin) {
  const monumentsContext = buildMonumentsContext(monuments)
  const systemInstruction = systemPromptTemplate.replace("{{MONUMENTS}}", monumentsContext)

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const isGemini3 = /^gemini-3/.test(model)
  const thinkingConfig = isGemini3
    ? { includeThoughts: true, thinkingLevel: THINKING_LEVEL }
    : { includeThoughts: true, thinkingBudget: -1 }

  const geminiRes = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig,
        },
      }),
    }),
    GEMINI_TIMEOUT,
    "Gemini stream"
  )

  if (!geminiRes.ok) {
    const err = await geminiRes.json().catch(() => ({}))
    const msg = err?.error?.message || `Gemini HTTP ${geminiRes.status}`
    throw new Error(msg)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  ;(async () => {
    let fullText = ""
    try {
      const reader = geminiRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let readerDone = false

      while (!readerDone) {
        const { done, value } = await reader.read()
        readerDone = done
        if (value) buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const json = line.slice(5).trim()
          if (!json || json === "[DONE]") {
            if (readerDone) break
            continue
          }
          try {
            const parsed = JSON.parse(json)

            const finishReason = parsed?.candidates?.[0]?.finishReason
            if (finishReason && finishReason !== "STOP") {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ error: `stop: ${finishReason}` })}\n\n`)
              )
            }

            const parts = parsed?.candidates?.[0]?.content?.parts || []
            for (const p of parts) {
              if (!p.text) continue
              if (p.thought) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ thinking: p.text })}\n\n`))
              } else {
                fullText += p.text
                await writer.write(encoder.encode(`data: ${JSON.stringify({ chunk: fullText })}\n\n`))
              }
            }
          } catch {}
        }
      }

      const structured = extractJsonBlock(fullText)
      if (structured?.pois?.length) {
        try {
          const monuments = await fetchMonuments(env)
          const resolvedPois = structured.pois
            .map(p => {
              const m = findMonumentByName(monuments, p.nome || p.name)
              if (!m) return null
              return {
                nome: m.nome,
                lat: m.coordinate.lat,
                lon: m.coordinate.lng,
                slug: m.slug,
              }
            })
            .filter(Boolean)

          if (resolvedPois.length >= 2) {
            const routeId = makeRouteId()
            const gpxText = await generateRouteGpx(
              structured.title || "Percorso Gubbio",
              structured.description || "",
              resolvedPois
            )

            await saveRoute(env, routeId, {
              id: routeId,
              title: structured.title || "Percorso Gubbio",
              description: structured.description || "",
              gpx: gpxText,
              pois: resolvedPois.map((p, i) => ({
                index: i + 1,
                name: p.nome,
                link: poiLink(p.slug),
                pinUrl: `${PIN_BASE_URL}/${Math.min(i + 1, 15)}.svg`,
                lat: p.lat,
                lon: p.lon,
              })),
              createdAt: Date.now(),
            })

            await writer.write(
              encoder.encode(`data: ${JSON.stringify({ routeReady: true, routeId })}\n\n`)
            )
          }
        } catch (err) {
          await writer.write(
            encoder.encode(`data: ${JSON.stringify({ error: `Generazione percorso fallita: ${err.message}` })}\n\n`)
          )
        }
      }

      await writer.write(encoder.encode("data: [DONE]\n\n"))
    } catch (err) {
      try {
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`)
        )
      } catch {}
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...corsHeaders(origin),
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || ""
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return jsonResponse({ status: "ok" }, 200, origin)
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/route/")) {
      const parts = url.pathname.split("/").filter(Boolean)
      const lastSegment = parts[3]

      const wantsGpx = lastSegment.endsWith(".gpx") || parts[4] === "gpx"
      const routeId = lastSegment.endsWith(".gpx")
        ? lastSegment.slice(0, -4)
        : lastSegment

      if (!routeId) {
        return jsonResponse({ error: "Id percorso mancante" }, 400, origin)
      }

      const data = await loadRoute(env, routeId)
      if (!data) {
        return jsonResponse({ error: "Percorso non trovato" }, 404, origin)
      }

      if (wantsGpx) {
        return new Response(data.gpx, {
          status: 200,
          headers: {
            "Content-Type": "application/gpx+xml",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        })
      }

      return jsonResponse(
        {
          id: data.id,
          title: data.title,
          description: data.description,
          gpxUrl: `https://ikuvium.insidegubbio.com/api/v1/route/${data.id}.gpx`,
          pois: data.pois,
          sections: [
            {
              paragraphs: data.pois.map(p => `${p.index} ${p.name}`),
            },
          ],
        },
        200,
        origin
      )
    }

    if (request.method === "POST" && url.pathname === "/api/v1/itinerary") {

      if (!ALLOWED_ORIGIN_PATTERN.test(origin)) {
        return jsonResponse({ error: "Origine non autorizzata" }, 403, origin)
      }

      const apiKey = env.GEMINI_API_KEY
      const systemPromptTemplate = env.SYSTEM_PROMPT
      if (!apiKey || !systemPromptTemplate) {
        return jsonResponse({ error: "Configurazione server mancante" }, 500, origin)
      }

      let body, monuments
      try {
        ;[body, monuments] = await Promise.all([
          request.json(),
          fetchMonuments(env),
        ])
      } catch (err) {
        if (err instanceof SyntaxError) {
          return jsonResponse({ error: "Body JSON non valido" }, 400, origin)
        }
        return jsonResponse(
          { error: err.message || "Errore nel recupero dei dati" },
          502,
          origin
        )
      }

      const prompt = (body?.prompt || "").trim()
      if (!prompt) {
        return jsonResponse({ error: "Campo 'prompt' mancante o vuoto" }, 400, origin)
      }

      if (!monuments.length) {
        return jsonResponse(
          { error: "Impossibile recuperare i monumenti. Riprova tra poco." },
          502,
          origin
        )
      }

      const model = env.GEMINI_MODEL || DEFAULT_MODEL

      try {
        return await streamGemini(env, apiKey, model, prompt, monuments, systemPromptTemplate, origin)
      } catch (err) {
        return jsonResponse({ error: err.message || "Errore Gemini" }, 502, origin)
      }
    }

    return jsonResponse({ error: "Not found" }, 404, origin)
  },
}
