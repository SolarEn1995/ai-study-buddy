/**
 * Cloudflare Worker - Claude API Proxy for Study Companion
 *
 * 環境變數（在 Cloudflare Dashboard 設定為 Secret）：
 *   ANTHROPIC_API_KEY  你的 Claude API Key
 *   ALLOWED_ORIGIN     允許的前端網址 (e.g. https://study.yourname.app)，本機開發可用 *
 *   APP_TOKEN          (選用) 簡單共用 token，避免別人盜用你的 endpoint
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler deploy
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// 簡單的 in-memory rate limit（per Worker isolate）
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

    // 選用：共用 token 驗證
    if (env.APP_TOKEN) {
      const token = request.headers.get("X-App-Token");
      if (token !== env.APP_TOKEN) {
        return json({ error: "Unauthorized" }, 401, cors);
      }
    }

    // Rate limit (依 IP)
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

    // 基本欄位驗證 + 上限保護
    const { model, max_tokens, messages } = body || {};
    if (!model || !messages || !Array.isArray(messages)) {
      return json({ error: "Missing model or messages" }, 400, cors);
    }
    const safeMaxTokens = Math.min(Number(max_tokens) || 1024, 2048);

    try {
      const resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model, max_tokens: safeMaxTokens, messages }),
      });

      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "application/json",
          ...cors,
        },
      });
    } catch (err) {
      return json({ error: "Upstream error", detail: String(err) }, 502, cors);
    }
  },
};
