# 學習戰友 · Study Companion 🎓

> **任何要搞懂的事，都先拍一張。**
>
> 拍照筆記 → AI 分析 → 卡關自動記錄 → SM-2 間隔複習。
> 不只大學四年——研究所、考證照、語言學習、職場進修、自我精進，通通能用。

## ✨ Features

- 📸 **拍照 / 截圖 / 拖放** 任何筆記、課本、講義、線上課程、技術文件、食譜...
- 🤖 **雙 AI 引擎切換**：Claude 3.5 Sonnet（視覺最強）/ Gemini 1.5 Flash（免費額度大）
- 🎯 **三級信心標註**：高信心 / 需驗證 / 建議自行計算
- 🚧 **卡關大全**：每次提問自動記錄成卡片
- 🔄 **SM-2 間隔複習**：依「不懂 / 模糊 / 懂了」自動排程下次出現
- 📚 **完全自訂科目 / 主題**：學科、證照、語言、興趣都能加
- 🧮 **KaTeX 公式渲染**：LaTeX 數學/物理公式自動排版
- 📱 **PWA**：手機加到主畫面就像 app，支援離線複習
- 💾 **localStorage 持久化**：關閉瀏覽器資料不消失
- 🔒 **Cloudflare Worker proxy**：API key 不暴露在前端

## 🎯 適用情境

| 角色 | 用法 |
|------|------|
| 大學生 / 研究生 | 上課筆記、教授板書、paper 截圖 |
| 上班族自學 | 線上課程、技術書、Coursera 講義 |
| 考證照 | PMP、AWS、會計師、考古題 |
| 語言學習 | 文法書、生字、文章逐句 |
| 程式自學 | LeetCode、文件、StackOverflow |
| 興趣養成 | 食譜、健身、樂理、修車手冊 |

## 🗂 專案結構

```
ai-study-buddy/
├── frontend/                # Vite + React PWA
│   ├── public/
│   │   ├── manifest.webmanifest
│   │   ├── sw.js            # Service Worker
│   │   └── icons/
│   ├── src/main.jsx
│   ├── study-companion.jsx  # 主元件
│   ├── index.html
│   ├── vite.config.js
│   ├── .env.example
│   └── package.json
└── proxy/                   # Cloudflare Worker
    ├── src/worker.js        # Claude + Gemini 雙引擎
    ├── wrangler.toml
    ├── package.json
    └── README.md
```

## 🚀 快速開始

### 1. 部署 Backend Proxy（5 分鐘）

```bash
cd proxy
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY    # Claude key（可選）
npx wrangler secret put GEMINI_API_KEY       # Gemini key（可選）
npx wrangler secret put APP_TOKEN            # 隨機字串
npx wrangler deploy
```

詳見 [proxy/README.md](./proxy/README.md)

### 2. 啟動前端

```bash
cd frontend
cp .env.example .env        # 填入 VITE_PROXY_URL 與 VITE_APP_TOKEN
npm install
npm run dev                 # http://localhost:5173
```

### 3. 安裝成 PWA（手機）

在 Chrome / Safari 開啟網站 → 選單 → **加到主畫面**
之後從手機桌面點開，就是全螢幕 app，支援離線複習。

## 🧠 SM-2 演算法

| 操作 | 下次出現 | EF 變化 |
|------|---------|---------|
| 😵 不懂 (q=0) | 10 分鐘後 | reps 歸零 |
| 🤔 模糊 (q=3) | 1 → 3 → 拉長 | EF 微幅下調 |
| ✅ 懂了 (q=5) | 1 → 3 → 7 → 17 天... | EF 上調 |

完全照 [Anki 的 SM-2 公式](https://en.wikipedia.org/wiki/SuperMemo#Algorithm_SM-2)。

## 🛣 Roadmap

- [x] localStorage 持久化
- [x] SM-2 間隔複習
- [x] Cloudflare Worker proxy
- [x] 科目自訂
- [x] KaTeX 公式渲染
- [x] Claude / Gemini 雙引擎切換
- [x] PWA (manifest + Service Worker)
- [ ] OCR 預處理（Tesseract.js）省 70% AI 成本
- [ ] 學習儀表板（熱力圖、進度統計）
- [ ] 概念標籤自動抽取（跨筆記關聯）
- [ ] 考前衝刺模式（考古題對照卡關清單）
- [ ] 匯出 PDF / Markdown / Anki deck
- [ ] 語音輸入（Web Speech API）
- [ ] 暗色模式
- [ ] Supabase 雲端同步

## 📄 License

MIT
