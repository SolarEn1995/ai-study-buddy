/**
 * Cloudflare Worker - AI Proxy for Study Companion
 *
 * 支援 Claude (Anthropic) 與 Gemini (Google) 雙引擎。
 *
 * 環境變數（用 wrangler secret put 設定）：
 *   ANTHROPIC_API_KEY  Claude API Key（可選）
 *   GEMINI_API_KEY     Gemini API Key（可選）
 *   ALLOWED_ORIGIN     允許的前端網址；本機開發可用 *
 *   APP_TOKEN          (選用) 簡單共用 token
 *
 * 前端呼叫方式：
 *   POST /             依 body.provider 決定（預設 claude）
 *   POST /claude       明確指定 Claude
 *   POST /gemini       明確指定 Gemini
 *
 * 統一回傳格式：
 *   { content: [{ text: "..." }], provider: "claude"|"gemini", model: "..." }
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.max;
}

function corsHeaders(origin, allowed) {
  const allow = allowed === "*" || origin === allowed ? origin || "*" : allowed;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ========== Claude ==========
async function callClaude(body, env) {
  const { model, max_tokens, messages } = body || {};
  if (!model || !messages || !Array.isArray(messages)) {
    return { status: 400, data: { error: "Missing model or messages" } };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return { status: 500, data: { error: "ANTHROPIC_API_KEY not configured" } };
  }
  const safeMaxTokens = Math.min(Number(max_tokens) || 1024, 2048);

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, max_tokens: safeMaxTokens, messages }),
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.ok) data.provider = "claude";
  return { status: resp.status, data };
}

// ========== Gemini ==========
function anthropicToGeminiContents(messages) {
  return messages.map((msg) => {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === "text") {
          parts.push({ text: item.text });
        } else if (item.type === "image" && item.source?.data) {
          parts.push({
            inline_data: {
              mime_type: item.source.media_type || "image/jpeg",
              data: item.source.data,
            },
          });
        }
      }
    }
    return { role, parts };
  });
}

async function callGemini(body, env) {
  const { model, max_tokens, messages } = body || {};
  if (!model || !messages || !Array.isArray(messages)) {
    return { status: 400, data: { error: "Missing model or messages" } };
  }
  if (!env.GEMINI_API_KEY) {
    return { status: 500, data: { error: "GEMINI_API_KEY not configured" } };
  }
  const safeMaxTokens = Math.min(Number(max_tokens) || 2048, 8192);
  const geminiModel = model.startsWith("gemini-") ? model : "gemini-2.5-flash";

  const url = `${GEMINI_URL}/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`;
  // Gemini 2.5 系列預設開啟 thinking，會吃掉大量 output token。設為 0 關閉。
  const generationConfig = { maxOutputTokens: safeMaxTokens, temperature: 0.7 };
  if (geminiModel.startsWith("gemini-2.5")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: anthropicToGeminiContents(messages),
      generationConfig,
    }),
  });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return {
      status: resp.status,
      data: { error: raw.error?.message || "Gemini upstream error", detail: raw },
    };
  }
  const text = raw.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return {
    status: 200,
    data: {
      content: [{ type: "text", text }],
      provider: "gemini",
      model: geminiModel,
      usage: raw.usageMetadata,
      finishReason: raw.candidates?.[0]?.finishReason,
    },
  };
}

// ========== Router ==========
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN || "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (env.APP_TOKEN) {
      const token = request.headers.get("X-App-Token");
      if (token !== env.APP_TOKEN) {
        return json({ error: "Unauthorized" }, 401, cors);
      }
    }

    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "unknown";
    if (rateLimited(ip)) {
      return json({ error: "Rate limit exceeded, try again later." }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const provider = (body.provider || (path.includes("gemini") ? "gemini" : "claude")).toLowerCase();

    try {
      const result = provider === "gemini"
        ? await callGemini(body, env)
        : await callClaude(body, env);
      return json(result.data, result.status, cors);
    } catch (err) {
      return json({ error: "Upstream error", detail: String(err) }, 502, cors);
    }
  },
};
