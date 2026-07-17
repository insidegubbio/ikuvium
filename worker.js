/*
 * insidegubbio's ai api based on workers
 */

var ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(([\w-]+\.)?insidegubbio\.com|([\w-]+\.)?insidegubbio\.framer\.ai)$/;
var DEFAULT_MODEL = "gemini-2.5-flash";
var memCache = null;
var memCacheTime = 0;
var MEM_TTL = 5 * 60 * 1e3;
var KV_TTL_SECONDS = 10 * 60;
var MONUMENTS_FETCH_TIMEOUT = 5e3;
var GEMINI_TIMEOUT = 55e3;
var MAX_OUTPUT_TOKENS = 14e3;
var THINKING_LEVEL = "low";
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN_PATTERN.test(origin || "") ? origin : "https://insidegubbio.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}
__name(jsonResponse, "jsonResponse");
function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise(
      (_, reject) => setTimeout(() => reject(new Error(`${label} dopo ${ms}ms`)), ms)
    )
  ]);
}
__name(withTimeout, "withTimeout");
function parseMonuments(data) {
  const list = Array.isArray(data?.monumenti) ? data.monumenti : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const m of list) {
    if (!m?.nome || seen.has(m.nome)) continue;
    seen.add(m.nome);
    out.push({
      nome: m.nome,
      valutazione: m.valutazione || "",
      visitabilita: m.visitabilita || "",
      coordinate: { lat: m.coordinate?.lat ?? 0, lng: m.coordinate?.lng ?? 0 }
    });
  }
  return out;
}
__name(parseMonuments, "parseMonuments");
async function fetchMonuments(env2) {
  const now = Date.now();
  if (memCache && now - memCacheTime < MEM_TTL) return memCache;
  if (env2.MONUMENTS_KV) {
    try {
      const raw = await env2.MONUMENTS_KV.get("monuments");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.length) {
          memCache = parsed;
          memCacheTime = now;
          return parsed;
        }
      }
    } catch {
    }
  }
  const res = await withTimeout(
    env2.MONUMENTI.fetch(new Request("https://console.insidegubbio.com/v2/articles/elenco-monumenti")),
    MONUMENTS_FETCH_TIMEOUT,
    "Fetch monumenti"
  );
  if (!res.ok) {
    console.error("Monumenti fetch failed:", res.status, (await res.text()).slice(0, 200));
    return memCache || [];
  }
  const data = await res.json();
  const monuments = parseMonuments(data);
  if (!monuments.length) return memCache || [];
  memCache = monuments;
  memCacheTime = now;
  if (env2.MONUMENTS_KV) {
    env2.MONUMENTS_KV.put("monuments", JSON.stringify(monuments), {
      expirationTtl: KV_TTL_SECONDS
    }).catch(() => {
    });
  }
  return monuments;
}
__name(fetchMonuments, "fetchMonuments");
function buildMonumentsContext(monuments) {
  return monuments.filter((m) => {
    if (!m.coordinate?.lat) return false;
    if (/non più esistente|non agibile|ruderi/.test(m.visitabilita)) return false;
    return true;
  }).map(
    (m, i) => `${i + 1}. ${m.nome} | coord: ${m.coordinate.lat.toFixed(4)},${m.coordinate.lng.toFixed(4)} | rilevanza: ${m.valutazione} | visitabilit\xE0: ${m.visitabilita}`
  ).join("\n");
}
__name(buildMonumentsContext, "buildMonumentsContext");
async function streamGemini(apiKey, model, userPrompt, monuments, systemPromptTemplate, origin) {
  const monumentsContext = buildMonumentsContext(monuments);
  const systemInstruction = systemPromptTemplate.replace("{{MONUMENTS}}", monumentsContext);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const isGemini3 = /^gemini-3/.test(model);
  const thinkingConfig = isGemini3
    ? { includeThoughts: true, thinkingLevel: THINKING_LEVEL }
    : { includeThoughts: true, thinkingBudget: -1 };

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
          thinkingConfig
        }
      })
    }),
    GEMINI_TIMEOUT,
    "Gemini stream"
  );
  if (!geminiRes.ok) {
    const err = await geminiRes.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini HTTP ${geminiRes.status}`;
    throw new Error(msg);
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    try {
      const reader = geminiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let readerDone = false;
      while (!readerDone) {
        const { done, value } = await reader.read();
        readerDone = done;
        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json || json === "[DONE]") {
            if (readerDone) break;
            continue;
          }
          try {
            const parsed = JSON.parse(json);
            const finishReason = parsed?.candidates?.[0]?.finishReason;
            if (finishReason && finishReason !== "STOP") {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ error: `stop: ${finishReason}` })}

`)
              );
            }
            const parts = parsed?.candidates?.[0]?.content?.parts || [];
            // Smista ogni part: se ha thought:true è un riepilogo del
            // ragionamento (lo mandiamo come evento "thinking" separato),
            // altrimenti è testo di risposta vero e proprio ("chunk").
            for (const p of parts) {
              if (!p.text) continue;
              const payload = p.thought ? { thinking: p.text } : { chunk: p.text };
              await writer.write(
                encoder.encode(`data: ${JSON.stringify(payload)}

`)
              );
            }
          } catch {
          }
        }
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      try {
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: err.message })}

`)
        );
      } catch {
      }
    } finally {
      writer.close().catch(() => {
      });
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...corsHeaders(origin)
    }
  });
}
__name(streamGemini, "streamGemini");
var worker_default = {
  async fetch(request, env2, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return jsonResponse({ status: "ok" }, 200, origin);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/itinerary") {
      if (!ALLOWED_ORIGIN_PATTERN.test(origin)) {
        return jsonResponse({ error: "Origine non autorizzata" }, 403, origin);
      }
      const apiKey = env2.GEMINI_API_KEY;
      const systemPromptTemplate = env2.SYSTEM_PROMPT;
      if (!apiKey || !systemPromptTemplate) {
        return jsonResponse({ error: "Configurazione server mancante" }, 500, origin);
      }
      let body, monuments;
      try {
        ;
        [body, monuments] = await Promise.all([
          request.json(),
          fetchMonuments(env2)
        ]);
      } catch (err) {
        if (err instanceof SyntaxError) {
          return jsonResponse({ error: "Body JSON non valido" }, 400, origin);
        }
        return jsonResponse(
          { error: err.message || "Errore nel recupero dei dati" },
          502,
          origin
        );
      }
      const prompt = (body?.prompt || "").trim();
      if (!prompt) {
        return jsonResponse({ error: "Campo 'prompt' mancante o vuoto" }, 400, origin);
      }
      if (!monuments.length) {
        return jsonResponse(
          { error: "Impossibile recuperare i monumenti. Riprova tra poco." },
          502,
          origin
        );
      }
      const model = env2.GEMINI_MODEL || DEFAULT_MODEL;
      try {
        return await streamGemini(apiKey, model, prompt, monuments, systemPromptTemplate, origin);
      } catch (err) {
        return jsonResponse({ error: err.message || "Errore Gemini" }, 502, origin);
      }
    }
    return jsonResponse({ error: "Not found" }, 404, origin);
  }
};
export {
  worker_default as default
};
