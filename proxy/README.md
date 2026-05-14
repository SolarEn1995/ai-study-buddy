# Study Companion Proxy

Cloudflare Workers 代理，保護 Claude / Gemini API Key 不暴露在前端。

## 部署步驟

```bash
# 1. 安裝 wrangler
npm install

# 2. 登入 Cloudflare（會開瀏覽器授權）
npx wrangler login

# 3. 設定機密 Key（至少設定一家，兩家都設前端就能切換）
npx wrangler secret put ANTHROPIC_API_KEY    # Claude key（可選）
npx wrangler secret put GEMINI_API_KEY       # Gemini key（可選）
npx wrangler secret put APP_TOKEN            # 可選，建議設一個隨機字串

# 4. 編輯 wrangler.toml，把 ALLOWED_ORIGIN 改成你的前端網址
#    本機開發階段可保持 "*"

# 5. 部署
npx wrangler deploy
```

部署完成後會得到一個 endpoint：
```
https://study-companion-proxy.<your-subdomain>.workers.dev
```

## 本機測試

```bash
npx wrangler dev
# 預設跑在 http://localhost:8787
```

## 前端設定

在 `study-companion.jsx` 中：

```js
const PROXY_URL = "https://study-companion-proxy.xxx.workers.dev";
const APP_TOKEN = "你設定的 APP_TOKEN";  // 與 secret 一致
```

## 安全特性

- API Key 只存在 Cloudflare Workers 環境變數，不會洩漏到前端
- CORS 限制只允許你指定的網址
- `APP_TOKEN` 共用密鑰防止別人盜用你的 endpoint
- Per-IP rate limit（每分鐘 20 次）
- `max_tokens` 上限 2048，避免被惡意刷費用
