# AI Study Buddy 🎓

陪你走完大學四年的 AI 學習夥伴。拍照筆記 → Claude AI 分析 → 卡關自動記錄 → SM-2 間隔複習。

## ✨ Features

- 📸 **拍照/截圖/拖放** 任何筆記、課本、講義
- 🤖 **Claude 3.5 Sonnet 視覺分析**：辨識內容、檢查錯誤、補充註解
- 🎯 **三級信心標註**：高信心 / 需驗證 / 建議自行計算
- 🚧 **卡關大全**：每次提問自動記錄成卡片
- 🔄 **SM-2 間隔複習**：依「不懂 / 模糊 / 懂了」自動排程下次出現
- 📚 **完全自訂科目**：大學四年 30+ 門課都能加
- 🧮 **KaTeX 公式渲染**：LaTeX 數學/物理公式自動排版
- 💾 **localStorage 持久化**：關閉瀏覽器資料不消失
- 🔒 **Cloudflare Worker proxy**：API key 不暴露在前端

## 🗂 專案結構

```
ai-study-buddy/
├── frontend/
│   └── study-companion.jsx    # React 單檔應用
└── proxy/
    ├── src/worker.js           # Cloudflare Worker
    ├── wrangler.toml
    └── README.md               # 部署步驟
```

## 🚀 快速開始

### 1. 部署 Backend Proxy（5 分鐘）

```bash
cd proxy
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY    # 貼上 Claude key
npx wrangler secret put APP_TOKEN            # 隨機字串
npx wrangler deploy
```

詳見 [proxy/README.md](./proxy/README.md)

### 2. 設定前端

把 `study-companion.jsx` 上方的 `PROXY_URL` 改成你部署後的 Workers URL，或設定 Vite 環境變數：

```env
VITE_PROXY_URL=https://study-companion-proxy.xxx.workers.dev
VITE_APP_TOKEN=你的-APP_TOKEN
```

### 3. 整合到你的 React 專案

```bash
npm create vite@latest my-study -- --template react
cd my-study
npm install
# 將 study-companion.jsx 放入 src/，並 import 到 App.jsx
npm run dev
```

## 🧠 SM-2 演算法說明

| 操作 | 下次出現 | EF 變化 |
|------|---------|---------|
| 😵 不懂 (q=0) | 10 分鐘後 | reps 歸零 |
| 🤔 模糊 (q=3) | 1 天 → 3 天 → 拉長 | EF 小幅下調 |
| ✅ 懂了 (q=5) | 1 → 3 → 7 → 17 天... | EF 上調 |

完全照 [Anki 用的 SM-2 公式](https://en.wikipedia.org/wiki/SuperMemo#Algorithm_SM-2)。

## 🛣 Roadmap

- [ ] PWA（手機加到主畫面）
- [ ] OCR 預處理（用 Tesseract.js 省 token）
- [ ] 跨筆記知識圖譜（同概念自動串聯）
- [ ] 考前模式（考古題對照卡關清單）
- [ ] 匯出 Anki deck
- [ ] Supabase 雲端同步（多裝置）

## 📄 License

MIT
