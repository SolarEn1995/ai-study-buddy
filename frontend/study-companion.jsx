import { useState, useRef, useEffect, useCallback } from "react";

// ===== Backend Proxy =====
// 部署 study-companion-proxy 後填入；本機開發改成 http://localhost:8787
const PROXY_URL = import.meta.env?.VITE_PROXY_URL || "https://study-companion-proxy.<your-subdomain>.workers.dev";
const APP_TOKEN = import.meta.env?.VITE_APP_TOKEN || "";

// ===== AI Providers =====
const AI_PROVIDERS = {
  claude: {
    label: "Claude",
    model: "claude-sonnet-4-20250514",
    icon: "🧠",
    color: "#C77B3F",
    desc: "Anthropic · 視覺最強",
  },
  gemini: {
    label: "Gemini",
    model: "gemini-2.5-flash",
    icon: "✨",
    color: "#1971C2",
    desc: "Google · 免費額度大",
  },
};
const PROVIDER_KEY = "study-companion-provider";
const getProvider = () => {
  if (typeof window === "undefined") return "gemini";
  return localStorage.getItem(PROVIDER_KEY) || "gemini";
};

async function callAI(payload, provider) {
  const useProvider = provider || getProvider();
  const headers = { "Content-Type": "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const model = payload.model || AI_PROVIDERS[useProvider].model;
  const body = JSON.stringify({ ...payload, model, provider: useProvider });

  // 最多重試 1 次（3xx/4xx 不重試、只對網路/5xx 重試）
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(PROXY_URL, { method: "POST", headers, body });
      if (!response.ok) {
        let detail = "";
        try { detail = (await response.json()).error || ""; } catch {}
        const err = new Error(`Proxy ${response.status}: ${detail || response.statusText}`);
        err.status = response.status;
        // 4xx 是請求本身的問題，重試也沒用
        if (response.status >= 400 && response.status < 500) throw err;
        throw err;
      }
      return response.json();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// 圖片壓縮：超過 maxDim 就縮小，輸出 JPEG。大多數床級圖片能縮到 < 500KB。
const compressImage = (dataUrl, maxDim = 1600, quality = 0.85) => new Promise((resolve) => {
  try {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // 防透明背景變黑
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  } catch {
    resolve(dataUrl);
  }
});

const DEFAULT_SUBJECTS = {
  math: { label: "數學", icon: "∑", color: "#E8590C", outline: "" },
  electronics: { label: "電子學", icon: "⚡", color: "#2B8A3E", outline: "" },
  electrical: { label: "電學", icon: "🔌", color: "#1971C2", outline: "" },
  digital: { label: "數位邏輯", icon: "⦡", color: "#9C36B5", outline: "" },
};

// 候選顏色（新增科目時輪流選用）
const SUBJECT_COLORS = [
  "#E8590C", "#2B8A3E", "#1971C2", "#9C36B5",
  "#C92A2A", "#5F3DC4", "#0CA678", "#D6336C",
  "#495057", "#1098AD", "#F08C00", "#5C940D",
];

const CONFIDENCE_STYLES = {
  high: { bg: "#E6F9E8", border: "#2B8A3E", label: "✓ 高信心", text: "#1B5E20" },
  medium: { bg: "#FFF3E0", border: "#E8590C", label: "⚠ 需驗證", text: "#BF360C" },
  low: { bg: "#FFEBEE", border: "#C62828", label: "✗ 建議自行計算", text: "#B71C1C" },
};

// ===== Persistence =====
const STORAGE_KEY = "study-companion-v1";

const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { stuckPoints: [], notes: [], subjects: DEFAULT_SUBJECTS };
    const parsed = JSON.parse(raw);
    // 只在「從未存過 subjects」時回退到預設；存過空物件代表使用者刻意清空，應尊重
    const hasSubjectsField = parsed && Object.prototype.hasOwnProperty.call(parsed, "subjects");
    return {
      stuckPoints: Array.isArray(parsed.stuckPoints) ? parsed.stuckPoints : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      subjects: hasSubjectsField && parsed.subjects && typeof parsed.subjects === "object"
        ? parsed.subjects
        : DEFAULT_SUBJECTS,
    };
  } catch {
    return { stuckPoints: [], notes: [], subjects: DEFAULT_SUBJECTS };
  }
};

const saveState = (stuckPoints, notes, subjects) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ stuckPoints, notes, subjects }));
    return { ok: true };
  } catch (e) {
    console.warn("無法寫入 localStorage：", e);
    const isQuota = e && (e.name === "QuotaExceededError"
      || e.code === 22 || e.code === 1014
      || /quota|storage/i.test(e.message || ""));
    return { ok: false, quota: isQuota, error: e };
  }
};

// ===== SM-2 Spaced Repetition =====
// quality: 0=不懂, 3=模糊, 5=懂了
const DAY_MS = 24 * 60 * 60 * 1000;

const initSRS = () => ({
  easeFactor: 2.5,
  interval: 0,            // 上一次的間隔（天）
  repetitions: 0,         // 連續答對次數
  nextReviewAt: Date.now(),
  lastReviewedAt: null,
});

const gradeCard = (card, quality) => {
  let { easeFactor = 2.5, interval = 0, repetitions = 0 } = card;

  if (quality < 3) {
    // 不懂 → 重置，10 分鐘後再看
    repetitions = 0;
    interval = 0;
    const nextReviewAt = Date.now() + 10 * 60 * 1000;
    return { ...card, easeFactor, interval, repetitions, nextReviewAt, lastReviewedAt: Date.now() };
  }

  // 模糊或懂了
  repetitions += 1;
  if (repetitions === 1) interval = 1;
  else if (repetitions === 2) interval = 3;
  else interval = Math.round(interval * easeFactor);

  // EF 調整公式 (SM-2)
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easeFactor < 1.3) easeFactor = 1.3;

  const nextReviewAt = Date.now() + interval * DAY_MS;
  return { ...card, easeFactor, interval, repetitions, nextReviewAt, lastReviewedAt: Date.now() };
};

const isDue = (card) => (card.nextReviewAt ?? 0) <= Date.now();

// ===== 大綱階層解析 =====
// 偵測「主章節 / 單元」開頭：第N單元、第N章、Ch.N、Chapter N、Part N、單元N、Unit N、X.Y 之上層 X
const isOutlineParent = (line) => {
  const s = line.trim();
  return /^(第\s*[\d一二三四五六七八九十百千]+\s*[單章篇部])/.test(s)
      || /^(單元|Unit|Part|Chapter|Ch)\b/i.test(s)
      || /^Ch\.?\s*\d+/i.test(s)
      || /^[【\[].*?[】\]]\s*\S/.test(s);
};
const parseOutline = (outline) => {
  const lines = (outline || "").split("\n").map(s => s.trim()).filter(Boolean);
  const groups = [];
  let current = null;
  for (const ln of lines) {
    if (isOutlineParent(ln)) {
      current = { parent: ln, children: [] };
      groups.push(current);
    } else {
      if (!current) { current = { parent: null, children: [] }; groups.push(current); }
      current.children.push(ln);
    }
  }
  return groups;
};

// ===== KaTeX 動態載入 =====
let katexLoadPromise = null;
const loadKatex = () => {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.katex) return Promise.resolve(window.katex);
  if (katexLoadPromise) return katexLoadPromise;
  katexLoadPromise = new Promise((resolve) => {
    // CSS
    if (!document.querySelector('link[data-katex]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
      link.setAttribute("data-katex", "1");
      document.head.appendChild(link);
    }
    // JS
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    script.onload = () => resolve(window.katex);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return katexLoadPromise;
};

// 將文字中的 $...$ 或 $$...$$ 切成片段
const splitLatex = (text) => {
  const parts = [];
  const regex = /(\$\$[^$]+\$\$|\$[^$\n]+\$)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
    const raw = m[0];
    const display = raw.startsWith("$$");
    const inner = raw.slice(display ? 2 : 1, display ? -2 : -1);
    parts.push({ type: "math", value: inner, display });
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
};

const KatexInline = ({ children, display = false }) => {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    loadKatex().then((katex) => {
      if (cancelled || !katex || !ref.current) return;
      try {
        katex.render(String(children || ""), ref.current, {
          throwOnError: false,
          displayMode: display,
          output: "html",
        });
      } catch {
        if (ref.current) ref.current.textContent = String(children || "");
      }
    });
    return () => { cancelled = true; };
  }, [children, display]);
  return display
    ? <div ref={ref} style={{ margin: "6px 0", overflowX: "auto" }} />
    : <span ref={ref} />;
};

const RenderWithMath = ({ text }) => (
  <>
    {splitLatex(text).map((p, i) =>
      p.type === "math"
        ? <KatexInline key={i} display={p.display}>{p.value}</KatexInline>
        : <span key={i}>{p.value}</span>
    )}
  </>
);

// #1 \u8907\u7fd2\u9801\u9375\u76e4\u5feb\u6377\u9375\uff1a\u7528 window CustomEvent \u9023\u63a5\u5916\u90e8\u76e3\u807d\u5668\u8207\u5167\u90e8 handler
const KeyboardBridge = ({ onGrade, onSkip }) => {
  useEffect(() => {
    const gradeHandler = (e) => onGrade(e.detail);
    const skipHandler = () => onSkip();
    window.addEventListener("review-grade", gradeHandler);
    window.addEventListener("review-skip", skipHandler);
    return () => {
      window.removeEventListener("review-grade", gradeHandler);
      window.removeEventListener("review-skip", skipHandler);
    };
  }, [onGrade, onSkip]);
  return null;
};

const formatDueLabel = (card) => {
  if (!card.nextReviewAt) return "未排程";
  const diff = card.nextReviewAt - Date.now();
  if (diff <= 0) return "今日待複習";
  const days = Math.ceil(diff / DAY_MS);
  if (days === 1) return "明天複習";
  return `${days} 天後`;
};

const DEMO_RESULTS = {
  math: `## 內容辨識：二次方程式求解\n二次方程式 ax² + bx + c = 0\n公式解：x = (-b ± √(b²-4ac)) / 2a [高信心]\n\n## 筆記中的範例\n求解 2x² + 5x - 3 = 0\na=2, b=5, c=-3\n判別式 D = 25 - 4(2)(-3) = 25 + 24 = 49 [高信心]\n\n❌ 錯誤發現\n筆記中寫 x = (-5 ± 7) / 2，但分母應該是 2a = 4，不是 2 [高信心]\n正確答案：x = (-5+7)/4 = 1/2 或 x = (-5-7)/4 = -3 [需驗證]\n\n💡 補充\n判別式 D > 0 代表有兩個相異實根；D = 0 為重根；D < 0 無實數解 [高信心]\n當 a=1 時可優先嘗試因式分解，比公式解更快 [高信心]`,
  electronics: `## 內容辨識：BJT 共射極放大器\n電路為 NPN BJT 共射極（Common Emitter）組態 [高信心]\n偏壓方式：電壓分壓偏壓（Voltage Divider Bias） [高信心]\n\n## 直流分析\nVB = VCC × R2/(R1+R2) [高信心]\nVE = VB - VBE ≈ VB - 0.7V [高信心]\nIC ≈ IE = VE/RE [高信心]\n\n⚠ 注意\n筆記中 VBE 取 0.7V 是矽電晶體的近似值，鍺電晶體應取 0.3V [高信心]\n\n💡 補充\n電壓增益 Av = -gm × (RC ∥ RL)，負號代表反相 [高信心]\n輸入阻抗 Zin ≈ R1 ∥ R2 ∥ (β × re)，其中 re = VT/IC [需驗證]`,
  electrical: `## 內容辨識：戴維寧等效電路\n將複雜電路簡化為一個電壓源 Vth 串聯一個電阻 Rth [高信心]\n\n## 步驟整理\n1. 移除負載，求開路電壓 Voc = Vth [高信心]\n2. 將所有獨立電源歸零（電壓源短路、電流源開路），求等效電阻 Rth [高信心]\n3. 接回負載，IL = Vth / (Rth + RL) [高信心]\n\n❌ 錯誤發現\n筆記中第二步寫「電流源短路」，這是錯的。電流源歸零應該是開路（斷路），電壓源歸零才是短路 [高信心]\n\n💡 補充\n諾頓等效是戴維寧的對偶：電流源 IN = Vth/Rth 並聯 Rth [高信心]\n最大功率轉移條件：RL = Rth 時負載獲得最大功率 [高信心]`,
  digital: `## 內容辨識：卡諾圖化簡（4變數）\nF(A,B,C,D) = Σm(0,1,2,5,8,9,10) [高信心]\n\n## 卡諾圖分組\n第一組：m0, m1, m8, m9 → B'D' [需驗證]\n第二組：m0, m2, m8, m10 → B'C' [需驗證]\n第三組：m1, m5 → A'CD' [建議自行計算]\n\n❌ 錯誤發現\n筆記中將 m1 和 m5 的分組結果寫成 A'C'D，但 m1=0001, m5=0101，共同項應重新檢查 [建議自行計算]\nm1=0001(A'B'C'D), m5=0101(A'B'CD)，變化的是 C，不變的是 A'B'D [建議自行計算]\n\n💡 補充\n化簡結果請自行用卡諾圖驗證 [建議自行計算]\nDon't care 項可以當 1 也可以當 0，選擇能讓分組更大的方向 [高信心]`,
};

export default function StudyCompanion() {
  const [view, setView] = useState("home");
  const [subject, setSubject] = useState(null);
  const [image, setImage] = useState(null);
  const [imageData, setImageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const initial = typeof window !== "undefined" ? loadState() : { stuckPoints: [], notes: [], subjects: DEFAULT_SUBJECTS };
  const [stuckPoints, setStuckPoints] = useState(initial.stuckPoints);
  const [askingAI, setAskingAI] = useState(false);
  const [questionInput, setQuestionInput] = useState("");
  const [followUp, setFollowUp] = useState(null);
  const [notes, setNotes] = useState(initial.notes);
  const [subjects, setSubjects] = useState(initial.subjects);
  const [currentCard, setCurrentCard] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null); // null | "new" | key
  const [subjectForm, setSubjectForm] = useState({ label: "", icon: "📘", color: SUBJECT_COLORS[0], outline: "" });
  const [provider, setProvider] = useState(getProvider());
  const [selectedNote, setSelectedNote] = useState(null);
  const [outlineExtracting, setOutlineExtracting] = useState(false);
  const [showAllSubjects, setShowAllSubjects] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [savedToStuck, setSavedToStuck] = useState(false);
  // #5 \u7be9\u9078
  const [historyFilter, setHistoryFilter] = useState("all"); // all | week | lowconf
  const [stuckFilter, setStuckFilter] = useState("unresolved"); // unresolved | due | resolved | all
  // #3 \u8907\u7fd2\u672c\u6b21\u6210\u679c\u7d71\u8a08
  const [reviewSession, setReviewSession] = useState({ active: false, total: 0, correct: 0, fuzzy: 0, wrong: 0, finishedAt: null });

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(PROVIDER_KEY, provider);
  }, [provider]);

  const aiCall = useCallback((payload) => callAI(payload, provider), [provider]);

  // 儲存警示狀態（#10）
  const [storageWarn, setStorageWarn] = useState(null); // null | "quota" | "error"
  // 首頁 onboarding 提示是否關閉（#7）
  const [hintDismissed, setHintDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("study-companion-hint-dismissed") === "1";
  });
  const dismissHint = () => {
    setHintDismissed(true);
    try { localStorage.setItem("study-companion-hint-dismissed", "1"); } catch {}
  };
  // 大綱辨識進度（#16）
  const [outlineProgress, setOutlineProgress] = useState({ current: 0, total: 0 });

  // 自動持久化（debounce 400ms，避免每次 keystroke 都同步寫入 localStorage）
  useEffect(() => {
    const t = setTimeout(() => {
      const result = saveState(stuckPoints, notes, subjects);
      if (!result.ok) {
        setStorageWarn(result.quota ? "quota" : "error");
      } else {
        setStorageWarn(w => (w ? null : w));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [stuckPoints, notes, subjects]);

  // 別名：保留原本 SUBJECTS 名稱以最小化變動
  const SUBJECTS = subjects;

  const openSubjectEditor = (key) => {
    if (key === "new") {
      setSubjectForm({
        label: "",
        icon: "📘",
        color: SUBJECT_COLORS[Object.keys(subjects).length % SUBJECT_COLORS.length],
        outline: "",
      });
    } else {
      setSubjectForm({ outline: "", ...subjects[key] });
    }
    setEditingSubject(key);
  };

  const saveSubject = () => {
    const label = subjectForm.label.trim();
    if (!label) return;
    if (editingSubject === "new") {
      // 生成不重複的 key
      let base = label.toLowerCase().replace(/[^a-z0-9]/g, "") || "subj";
      let key = base;
      let i = 2;
      while (subjects[key]) { key = `${base}${i++}`; }
      setSubjects((prev) => ({ ...prev, [key]: { ...subjectForm, label } }));
    } else {
      setSubjects((prev) => ({ ...prev, [editingSubject]: { ...subjectForm, label } }));
    }
    setEditingSubject(null);
  };

  const deleteSubject = (key) => {
    const used = stuckPoints.some((p) => p.subject === key);
    const msg = used
      ? `「${subjects[key].label}」有相關卡關紀錄，刪除後卡片仍會保留但失去科目歸屬。確定刪除？`
      : `確定刪除「${subjects[key].label}」？`;
    if (!window.confirm(msg)) return;
    setSubjects((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setEditingSubject(null);
  };

  const extractOutlineFromImages = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    setOutlineExtracting(true);
    setOutlineProgress({ current: 0, total: files.length });
    try {
      // 讀取所有圖檔為 base64（不計入進度，只是讀檔）
      const images = await Promise.all(Array.from(files).map(file => new Promise((resolve, reject) => {
        if (!file.type.startsWith("image/")) return resolve(null);
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })));
      const validImages = images.filter(Boolean);
      if (validImages.length === 0) return;
      setOutlineProgress({ current: 0, total: validImages.length });

      const content = [
        ...validImages.map(data => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
        { type: "text", text: `這${validImages.length > 1 ? `${validImages.length} 張` : "張"}圖片是課程大綱/章節目錄。請辨識出所有章節標題，整理成乾淨清單。

要求：
1. 只輸出章節標題，**每行一個**，不要任何前後綴說明
2. 保留原始章節編號（如 Ch.1、第一章、Chapter 1、1.1 等）
3. 同一章節的子小節可省略，只保留主章節；除非整份大綱只有小節
4. 不要加任何 markdown 符號（不要 #、*、- 開頭）
5. 順序依照圖片中由上到下、由左到右

直接輸出清單，不要任何說明文字。` },
      ];

      const data = await aiCall({
        max_tokens: 2048,
        messages: [{ role: "user", content }],
      });
      const text = (data.content?.map(c => c.text || "").join("\n") || "").trim();
      // 清理：移除 markdown 符號、空行
      const cleaned = text
        .split("\n")
        .map(l => l.trim().replace(/^[-*#>\d.]+\s*/, m => /^\d/.test(m) ? m : "").replace(/^[-*>]\s+/, "").trim())
        .filter(Boolean)
        .join("\n");
      setSubjectForm(prev => ({
        ...prev,
        outline: prev.outline ? `${prev.outline.trim()}\n${cleaned}` : cleaned,
      }));
    } catch (err) {
      alert("辨識失敗：" + err.message);
    } finally {
      setOutlineExtracting(false);
      setOutlineProgress({ current: 0, total: 0 });
    }
  }, [aiCall]);

  const addStuckPoint = (point) => {
    setStuckPoints((prev) => [{
      id: Date.now(), ...point, subject, timestamp: new Date().toLocaleDateString("zh-TW"), resolved: false,
      ...initSRS(),
    }, ...prev]);
  };

  const exportData = () => {
    const payload = {
      app: "study-companion",
      version: 1,
      exportedAt: new Date().toISOString(),
      stuckPoints,
      notes,
      subjects,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `study-companion-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importData = (file, mode = "merge") => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.app !== "study-companion") throw new Error("不是有效的備份檔");
        const importedStuck = Array.isArray(data.stuckPoints) ? data.stuckPoints : [];
        const importedNotes = Array.isArray(data.notes) ? data.notes : [];
        const importedSubjects = (data.subjects && typeof data.subjects === "object") ? data.subjects : {};

        if (mode === "replace") {
          setStuckPoints(importedStuck);
          setNotes(importedNotes);
          setSubjects(Object.keys(importedSubjects).length > 0 ? importedSubjects : DEFAULT_SUBJECTS);
          alert(`✓ 已還原備份\n卡關 ${importedStuck.length}・歷史 ${importedNotes.length}・科目 ${Object.keys(importedSubjects).length}`);
        } else {
          // merge: 以 id 去重
          setStuckPoints(prev => {
            const ids = new Set(prev.map(p => p.id));
            return [...prev, ...importedStuck.filter(p => !ids.has(p.id))];
          });
          setNotes(prev => {
            const ids = new Set(prev.map(n => n.id));
            return [...prev, ...importedNotes.filter(n => !ids.has(n.id))];
          });
          // 科目合併：本機若仍是預設值（未被使用者改動）→ 用備份蓋掉；否則保留本機
          setSubjects(prev => {
            const next = { ...prev };
            for (const [k, v] of Object.entries(importedSubjects)) {
              const isUntouchedDefault = DEFAULT_SUBJECTS[k]
                && next[k]
                && JSON.stringify(next[k]) === JSON.stringify(DEFAULT_SUBJECTS[k]);
              if (!next[k] || isUntouchedDefault) next[k] = v;
            }
            return next;
          });
          alert(`✓ 已合併備份\n新增卡關 ${importedStuck.length}・新增歷史 ${importedNotes.length}`);
        }
      } catch (err) {
        alert("匯入失敗：" + err.message);
      }
    };
    reader.readAsText(file);
  };

  const addNote = (note) => {
    setNotes((prev) => [{ id: Date.now(), ...note, subject, timestamp: new Date().toLocaleDateString("zh-TW") }, ...prev]);
  };

  const processFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const raw = ev.target.result;
      // 允許先快速預覽，背景壓縮完再換上
      setImage(raw);
      try {
        const compressed = await compressImage(raw);
        setImage(compressed);
        setImageData(compressed.split(",")[1]);
      } catch {
        setImageData(raw.split(",")[1]);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  // Paste handler
  useEffect(() => {
    if (view !== "upload") return;
    const handler = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          processFile(item.getAsFile());
          break;
        }
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [view, processFile]);

  // 全域 ESC 關閉彈出層：拍照選科目 sheet、編輯科目表單
  useEffect(() => {
    if (!pickerOpen && editingSubject === null) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (pickerOpen) setPickerOpen(false);
      else if (editingSubject !== null) setEditingSubject(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, editingSubject]);

  // #1 \u8907\u7fd2\u9801\u9375\u76e4\u5feb\u6377\u9375 + #3 \u9032\u5165 review \u6642\u521d\u59cb\u5316 session
  useEffect(() => {
    if (view !== "review") return;
    // \u521d\u59cb\u5316\u9019\u6b21 session\uff08\u53ea\u5728\u5c1a\u672a active \u6642\uff09
    setReviewSession(s => s.active ? s : { active: true, total: 0, correct: 0, fuzzy: 0, wrong: 0, finishedAt: null });
    const onKey = (e) => {
      // \u907f\u514d\u8f38\u5165\u6846\u88e1\u8aa4\u89f8
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "enter") {
        e.preventDefault();
        setShowAnswer(v => !v);
      } else if (k === "1") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("review-grade", { detail: 0 }));
      } else if (k === "2") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("review-grade", { detail: 3 }));
      } else if (k === "3") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("review-grade", { detail: 5 }));
      } else if (k === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("review-skip"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) processFile(files[0]);
  }, [processFile]);

  const handleFilePick = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = ""; // 允許再次選同一檔
  }, [processFile]);

  const analyzeImage = async (useDemo = false) => {
    if (!useDemo && !imageData) return;
    setLoading(true);
    setAiResult(null);
    setFollowUp(null);
    setQuestionInput("");
    setSavedToStuck(false);

    if (useDemo) {
      await new Promise((r) => setTimeout(r, 1500));
      const result = DEMO_RESULTS[subject] || DEMO_RESULTS.math;
      setAiResult(result);
      addNote({ content: result, type: "analysis" });
      setView("result");
      setLoading(false);
      return;
    }

    try {
      const subjectLabel = SUBJECTS[subject].label;
      const outline = (SUBJECTS[subject]?.outline || "").trim();
      const outlineBlock = outline
        ? `\n\n本科目大綱（請從中選一個最相關單元，**完全照抄單元名稱**）：\n${outline}`
        : "";
      const data = await aiCall({
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } },
            { type: "text", text: `你是一位${subjectLabel}學習助教。請分析這張筆記/課程頁面的圖片，請用繁體中文回答：

**最開頭**請先輸出這兩行（後面才是正文）：
標題：[15字內、能讓人一眼看懂這張圖在算/問什麼，例如「二次函數配方法求頂點」]
所屬單元：${outline ? "[從下方大綱中選一個，完全照抄]" : "[依內容自行判定一個合理的單元名稱，例如「Ch.3 三角函數」]"}${outlineBlock}

接著開始正文：
1. **內容辨識**：辨識圖片中的文字、公式、電路圖等內容
2. **正確性檢查**：如果發現錯誤，明確指出並提供正確版本
3. **補充註解**：為重要概念加上補充說明
4. **信心指標**：每個分析項目後標註 [高信心]、[需驗證] 或 [建議自行計算]

格式：
- 用 ## 標題分段，錯誤用 ❌ 開頭，警告用 ⚠ 開頭，補充用 💡 開頭
- 所有數學/物理公式請用 LaTeX 包在 $...$（行內）或 $$...$$（獨立行）
- 範例：行內寫 $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$；獨立式寫 $$V_{out} = -\\frac{R_f}{R_{in}} V_{in}$$` },
          ],
        }],
      });
      const text = data.content?.map((c) => c.text || "").join("\n") || "無法分析此圖片";
      const titleMatch = text.match(/標題[:：]\s*(.+)/);
      const unitMatch = text.match(/所屬單元[:：]\s*(.+)/);
      const title = titleMatch ? titleMatch[1].trim().replace(/^\[|\]$/g, "") : "";
      const unit = unitMatch ? unitMatch[1].trim().replace(/^\[|\]$/g, "") : "";
      // 從顯示內容中移除這兩行 metadata
      const cleanText = text.replace(/^\s*標題[:：].*\n?/m, "").replace(/^\s*所屬單元[:：].*\n?/m, "").trim();
      setAiResult(cleanText);
      addNote({ content: cleanText, type: "analysis", title, unit });
      setView("result");
      // 分析完成：釋放圖片記憶體（避免 base64 長期滞留在 state）
      setImage(null);
      setImageData(null);
    } catch (err) {
      setAiResult("分析時發生錯誤：" + err.message + "\n\n\u8acb檢查網路連線、或在首頁切換另一個 AI 引擎後重試。");
      setView("result");
    } finally {
      setLoading(false);
    }
  };

  const askFollowUp = async () => {
    if (!questionInput.trim()) return;
    setAskingAI(true);
    setFollowUp(null);
    const q = questionInput;

    try {
      const subjectLabel = SUBJECTS[subject]?.label || "一般";
      const outline = (SUBJECTS[subject]?.outline || "").trim();
      const outlineBlock = outline
        ? `\n\n本科目大綱（請從中選一個最相關單元，**完全照抄單元名稱**）：\n${outline}`
        : "";
      const data = await aiCall({
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: `你是一位${subjectLabel}學習助教。學生的問題：${q}

上下文：
${aiResult || "（無）"}

用繁體中文，引導式回答（不直接給答案）。
所有數學/物理公式請用 LaTeX 包在 $...$ 或 $$...$$。
最後附上：
卡關摘要：[一句話]
難度：[1-5]
建議複習：[相關概念]${outlineBlock ? "\n所屬單元：[從大綱選一個]" : ""}${outlineBlock}`,
        }],
      });
      const text = data.content?.map((c) => c.text || "").join("\n") || "無法回答";
      setFollowUp(text);

      const summaryMatch = text.match(/卡關摘要：(.+)/);
      const difficultyMatch = text.match(/難度：(\d)/);
      const reviewMatch = text.match(/建議複習：(.+)/);
      const unitMatch = text.match(/所屬單元：(.+)/);
      if (summaryMatch) {
        addStuckPoint({
          summary: summaryMatch[1].trim(),
          difficulty: difficultyMatch ? parseInt(difficultyMatch[1]) : 3,
          reviewTopic: reviewMatch ? reviewMatch[1].trim() : "",
          unit: unitMatch ? unitMatch[1].trim().replace(/^\[|\]$/g, "") : "",
          question: q,
          answer: text,
        });
      }
    } catch (err) {
      setFollowUp("回答時發生錯誤：" + err.message);
    } finally {
      setAskingAI(false);
      setQuestionInput("");
    }
  };

  const renderAIContent = (text) => {
    // 處理粗體 **xxx** → <strong>
    const renderInline = (s) => {
      const parts = s.split(/(\*\*[^*]+\*\*)/g);
      return parts.map((part, idx) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={idx} style={{ fontWeight: 700, color: "#1a1a1a" }}>{part.slice(2, -2)}</strong>;
        }
        return <RenderWithMath key={idx} text={part} />;
      });
    };

    return text.split("\n").map((line, i) => {
      if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
      const isH1 = /^#\s+/.test(line);
      const isH2 = /^##\s+/.test(line);
      const isH3 = /^###\s+/.test(line);
      const isBullet = /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line);
      const isError = line.startsWith("❌");
      const isWarn = line.startsWith("⚠");
      const isTip = line.startsWith("💡");

      const hasHigh = line.includes("[高信心]");
      const hasMed = line.includes("[需驗證]");
      const hasLow = line.includes("[建議自行計算]");
      const conf = hasHigh ? "high" : hasMed ? "medium" : hasLow ? "low" : null;
      const clean = line
        .replace(/\[高信心\]|\[需驗證\]|\[建議自行計算\]/g, "")
        .replace(/^#{1,3}\s*/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "");

      if (isH1) return <h2 key={i} style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a", marginTop: 18, marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #eee" }}>{renderInline(clean)}</h2>;
      if (isH2) return <h3 key={i} style={{ fontSize: 15, fontWeight: 700, color: "#222", marginTop: 14, marginBottom: 4 }}>{renderInline(clean)}</h3>;
      if (isH3) return <h4 key={i} style={{ fontSize: 14, fontWeight: 600, color: "#333", marginTop: 10, marginBottom: 2 }}>{renderInline(clean)}</h4>;

      const bg = isError ? "#FFF0F0" : isWarn ? "#FFF8F0" : isTip ? "#F0FFF4" : "transparent";
      const bl = isError ? "#C62828" : isWarn ? "#E8590C" : isTip ? "#2B8A3E" : "transparent";

      return (
        <div key={i} style={{ fontSize: 13, lineHeight: 1.75, color: "#444", padding: bg !== "transparent" ? "6px 10px" : "2px 0", borderRadius: 6, background: bg, borderLeft: bl !== "transparent" ? `3px solid ${bl}` : "none", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", marginBottom: 2, paddingLeft: isBullet ? 16 : (bg !== "transparent" ? 10 : 0) }}>
          {isBullet && <span style={{ color: "#999", marginLeft: -10 }}>•</span>}
          <span style={{ flex: 1 }}>{renderInline(clean)}</span>
          {conf && (
            <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, fontWeight: 500, whiteSpace: "nowrap", background: CONFIDENCE_STYLES[conf].bg, color: CONFIDENCE_STYLES[conf].text, border: `1px solid ${CONFIDENCE_STYLES[conf].border}` }}>
              {CONFIDENCE_STYLES[conf].label}
            </span>
          )}
        </div>
      );
    });
  };

  // ===== VIEWS =====
  const P = ({ children }) => <div style={{ padding: "20px 18px", animation: "fadeUp 0.3s ease", maxWidth: 480, margin: "0 auto" }}>{children}</div>;
  const Back = ({ to = "home", label = "← 返回" }) => <button onClick={() => { setView(to); if (to === "home") { setImage(null); setImageData(null); setAiResult(null); setFollowUp(null); setSavedToStuck(false); } }} style={{ background: "none", border: "none", fontSize: 14, color: "#888", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{label}</button>;

  if (view === "home") {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "夜深了" : hour < 11 ? "早安" : hour < 14 ? "中午好" : hour < 18 ? "午安" : hour < 22 ? "晚上好" : "夜深了";
    const dueCount = stuckPoints.filter(p => !p.resolved && isDue(p)).length;
    const unresolvedCount = stuckPoints.filter(p => !p.resolved).length;
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekNew = stuckPoints.filter(p => p.id > oneWeekAgo).length;
    const totalNotes = notes.length;
    // 下一張到期時間（用於 nav 顯示）
    const nextDue = stuckPoints
      .filter(p => !p.resolved && p.nextReviewAt)
      .reduce((min, p) => (p.nextReviewAt < min ? p.nextReviewAt : min), Infinity);
    const nextDueLabel = (() => {
      if (dueCount > 0) return `複習 · ${dueCount}`;
      if (unresolvedCount === 0) return "複習";
      if (!isFinite(nextDue)) return "複習";
      const diff = nextDue - Date.now();
      const days = Math.ceil(diff / DAY_MS);
      if (days <= 1) return "明日到期";
      return `${days} 天後`;
    })();

    return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#F5F6FA" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}`}</style>

      {/* 漸層 Hero */}
      <div style={{ background: "linear-gradient(135deg,#1a1a1a 0%,#2d2d44 60%,#1971C2 100%)", color: "#fff", padding: "32px 22px 80px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -60, right: -40, width: 220, height: 220, borderRadius: "50%", background: "radial-gradient(circle,#ffffff20,transparent 70%)" }} />
        <div style={{ position: "absolute", bottom: -80, left: -60, width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle,#1971C230,transparent 70%)" }} />
        <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <p style={{ fontSize: 13, opacity: 0.8 }}>{greeting} 👋</p>
              <h1 style={{ fontSize: 24, fontWeight: 900, marginTop: 2, letterSpacing: 0.5 }}>學習戰友</h1>
            </div>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "#ffffff15", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 900, border: "1px solid #ffffff20" }}>學</div>
          </div>
          <p style={{ fontSize: 14, opacity: 0.7, marginTop: 14, lineHeight: 1.6 }}>任何要搞懂的事，<br/>都先拍一張。</p>

          {/* AI 引擎切換（玻璃效果） */}
          <div style={{ display: "flex", gap: 4, padding: 4, background: "#ffffff15", backdropFilter: "blur(10px)", borderRadius: 12, border: "1px solid #ffffff20", marginTop: 18 }}>
            {Object.entries(AI_PROVIDERS).map(([key, val]) => {
              const active = provider === key;
              return (
                <button key={key} onClick={() => setProvider(key)}
                  style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 6px", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: active ? 700 : 500, background: active ? "#fff" : "transparent", color: active ? "#1a1a1a" : "#fff", transition: "all 0.15s" }}>
                  <span style={{ fontSize: 14 }}>{val.icon}</span>
                  <span>{val.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 浮動統計卡 */}
      <div style={{ maxWidth: 480, margin: "-58px auto 0", padding: "0 18px", position: "relative", zIndex: 2 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, background: "#fff", borderRadius: 16, padding: "16px 6px", boxShadow: "0 8px 30px rgba(0,0,0,0.08)" }}>
          {[
            { num: dueCount, label: "今日複習", color: "#E8590C", emoji: "🔥" },
            { num: unresolvedCount, label: "未突破", color: "#1971C2", emoji: "🚧" },
            { num: weekNew, label: "本週新增", color: "#2B8A3E", emoji: "✨" },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: "center", borderRight: i < 2 ? "1px solid #f0f0f0" : "none", padding: "4px 6px" }}>
              <div style={{ fontSize: 20 }}>{s.emoji}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: s.color, marginTop: 2 }}>{s.num}</div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <P>
        {/* 主要 CTA：到期複習 */}
        {dueCount > 0 && (
          <button
            onClick={() => { setCurrentCard(0); setShowAnswer(false); setView("review"); }}
            style={{ width: "100%", marginTop: 20, padding: "16px 18px", border: "none", borderRadius: 14, cursor: "pointer", background: "linear-gradient(135deg,#E8590C,#FF8C42)", color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 6px 18px #E8590C40" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22, animation: "float 2s ease-in-out infinite", display: "inline-block" }}>⚡</span>
              <span>有 {dueCount} 張卡片等你複習</span>
            </span>
            <span style={{ fontSize: 18 }}>→</span>
          </button>
        )}

        {/* #8 繼續上一題：快速回到最近一則分析 */}
        {notes[0] && (() => {
          const last = notes[0];
          const subj = SUBJECTS[last.subject];
          const preview = last.title || (last.content || "").replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 30);
          return (
            <button onClick={() => { setSelectedNote(last); setView("history"); }}
              style={{ width: "100%", marginTop: dueCount > 0 ? 10 : 20, padding: "12px 14px", border: "1px solid #eef0f4", borderRadius: 12, cursor: "pointer", background: "#fff", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10, textAlign: "left", boxShadow: "0 2px 8px rgba(0,0,0,0.03)" }}>
              <span style={{ fontSize: 20, width: 36, height: 36, borderRadius: 10, background: subj ? `${subj.color}15` : "#f0f0f0", color: subj?.color || "#888", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {subj?.icon || "📌"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#999" }}>繼續上一題 · {last.timestamp}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {preview}
                </div>
              </div>
              <span style={{ color: "#bbb", fontSize: 16 }}>›</span>
            </button>
          );
        })()}

        {/* 科目區 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22, marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#1a1a1a" }}>選擇科目開始</h2>
          <button onClick={() => setView("subjects")}
            style={{ fontSize: 12, color: "#1971C2", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 500 }}>
            管理 →
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {Object.entries(SUBJECTS).slice(0, showAllSubjects ? Object.keys(SUBJECTS).length : 6).map(([key, val]) => (
            <button key={key} onClick={() => { setSubject(key); setView("subject-home"); }}
              style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, padding: "16px 14px", border: "1px solid #eef0f4", borderRadius: 14, cursor: "pointer", background: "#fff", fontFamily: "inherit", textAlign: "left", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", transition: "transform 0.15s", overflow: "hidden" }}
              onMouseDown={(e) => e.currentTarget.style.transform = "scale(0.97)"}
              onMouseUp={(e) => e.currentTarget.style.transform = ""}
              onMouseLeave={(e) => e.currentTarget.style.transform = ""}>
              <div style={{ position: "absolute", top: 0, right: 0, width: 50, height: 50, background: `radial-gradient(circle at top right,${val.color}25,transparent 70%)`, pointerEvents: "none" }} />
              <span style={{ fontSize: 26, width: 40, height: 40, borderRadius: 10, background: `${val.color}15`, display: "inline-flex", alignItems: "center", justifyContent: "center", color: val.color }}>{val.icon}</span>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#1a1a1a" }}>{val.label}</span>
              <span style={{ fontSize: 11, color: "#999" }}>{notes.filter(n => n.subject === key).length} 則筆記</span>
            </button>
          ))}
          {Object.keys(SUBJECTS).length > 6 && !showAllSubjects && (
            <button onClick={() => setShowAllSubjects(true)}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: "16px 12px", border: "1px solid #eef0f4", borderRadius: 14, cursor: "pointer", background: "#fff", fontFamily: "inherit", fontSize: 13, color: "#1971C2", fontWeight: 600, minHeight: 100, boxShadow: "0 2px 8px rgba(0,0,0,0.03)" }}>
              <span style={{ fontSize: 22 }}>⋯</span>
              <span>展開全部</span>
              <span style={{ fontSize: 11, color: "#999", fontWeight: 400 }}>還有 {Object.keys(SUBJECTS).length - 6} 個</span>
            </button>
          )}
          <button onClick={() => { openSubjectEditor("new"); setView("subjects"); }}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: "16px 12px", border: "1.5px dashed #d0d4dc", borderRadius: 14, cursor: "pointer", background: "transparent", fontFamily: "inherit", fontSize: 13, color: "#888", minHeight: 100 }}>
            <span style={{ fontSize: 24 }}>+</span>
            <span>新增科目</span>
          </button>
        </div>

        {/* #10 儲存警示（只在 quota / error 時出現） */}
        {storageWarn && (
          <div style={{ marginTop: 18, padding: "12px 14px", borderRadius: 12, background: storageWarn === "quota" ? "#FFF3E0" : "#FFEBEE", border: `1px solid ${storageWarn === "quota" ? "#E8590C" : "#C62828"}`, display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 20 }}>{storageWarn === "quota" ? "⚠️" : "❌"}</span>
            <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: storageWarn === "quota" ? "#BF360C" : "#B71C1C" }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                {storageWarn === "quota" ? "瀏覽器儲存空間不足" : "資料寫入失敗"}
              </div>
              <div>
                {storageWarn === "quota"
                  ? "新資料可能未被保存。請「匯出備份」後刪除部分舊紀錄。"
                  : "請檢查是否使用無痕模式或關閉了 cookie / storage。"}
              </div>
              <button onClick={() => setView("subjects")}
                style={{ marginTop: 6, padding: "6px 10px", border: "none", borderRadius: 6, background: storageWarn === "quota" ? "#E8590C" : "#C62828", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                前往備份 →
              </button>
            </div>
          </div>
        )}

        {/* 入口提示文：#7 已用過 ≥5 則或手動關閉後就隱藏 */}
        {!hintDismissed && totalNotes < 5 && (
          <div style={{ marginTop: 22, padding: "10px 14px", borderRadius: 10, background: "#fff", border: "1px solid #eef0f4", position: "relative" }}>
            <button onClick={dismissHint} aria-label="關閉提示"
              style={{ position: "absolute", top: 4, right: 6, background: "none", border: "none", color: "#bbb", fontSize: 14, cursor: "pointer", padding: "4px 8px", fontFamily: "inherit", lineHeight: 1 }}>×</button>
            <p style={{ fontSize: 11, color: "#888", textAlign: "center", lineHeight: 1.7 }}>
              📷 拍題 → 🧠 AI 解析存「歷史」<br/>
              🤔 追問不懂 → 自動進「卡關」 → 🔄 排程「複習」
            </p>
          </div>
        )}
        <p style={{ fontSize: 11, color: "#bbb", textAlign: "center", marginTop: 12, paddingBottom: 110 }}>
          {AI_PROVIDERS[provider]?.desc} · 累積 {totalNotes} 則筆記
        </p>
      </P>

      {/* ===== 底部固定導航 + 中央拍照 CTA ===== */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, pointerEvents: "none" }}>
        <div style={{ maxWidth: 480, margin: "0 auto", position: "relative", pointerEvents: "auto" }}>
          <div style={{ background: "#fff", borderTop: "1px solid #eef0f4", boxShadow: "0 -4px 20px rgba(0,0,0,0.06)", padding: "10px 8px 14px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", alignItems: "center", borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <button onClick={() => setView("home")}
              style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontFamily: "inherit", color: "#1a1a1a" }}>
              <span style={{ fontSize: 20 }}>🏠</span>
              <span style={{ fontSize: 10, fontWeight: 600 }}>首頁</span>
            </button>
            <button onClick={() => setView("stuck")}
              style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontFamily: "inherit", color: "#666" }}>
              <span style={{ fontSize: 20 }}>🚧</span>
              <span style={{ fontSize: 10 }}>卡關 {unresolvedCount > 0 && `· ${unresolvedCount}`}</span>
            </button>
            <div style={{ pointerEvents: "none" }} /> {/* 中央留空給浮動 CTA */}
            <button onClick={() => {
              if (dueCount > 0) { setCurrentCard(0); setShowAnswer(false); setView("review"); }
              else { setView("stuck"); }
            }}
              title={dueCount > 0 ? "開始複習" : (unresolvedCount === 0 ? "尚無卡關" : `下一張：${nextDueLabel}`)}
              style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontFamily: "inherit", color: dueCount > 0 ? "#E8590C" : "#999" }}>
              <span style={{ fontSize: 20 }}>{dueCount > 0 ? "🔄" : (unresolvedCount === 0 ? "✅" : "📅")}</span>
              <span style={{ fontSize: 10, fontWeight: dueCount > 0 ? 600 : 400 }}>{nextDueLabel}</span>
            </button>
            <button onClick={() => { setSelectedNote(null); setView("history"); }}
              style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontFamily: "inherit", color: "#666" }}>
              <span style={{ fontSize: 20 }}>📖</span>
              <span style={{ fontSize: 10 }}>歷史</span>
            </button>
          </div>

          {/* 中央懸浮拍照 CTA（白色外圈讓主動作「浮」在 nav 之上） */}
          <button onClick={() => setPickerOpen(true)}
            aria-label="拍照 / 上傳新題目"
            style={{ position: "absolute", left: "50%", top: -26, transform: "translateX(-50%)", width: 62, height: 62, borderRadius: "50%", border: "5px solid #fff", background: "linear-gradient(135deg,#1971C2,#5F3DC4)", color: "#fff", fontSize: 24, cursor: "pointer", boxShadow: "0 6px 20px rgba(25,113,194,0.45)", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
            📷
          </button>
        </div>
      </div>

      {/* ===== 拍照 CTA: 科目選擇 Sheet ===== */}
      {pickerOpen && (
        <div onClick={() => setPickerOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center", animation: "fadeUp 0.2s ease-out" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 480, background: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: "20px 20px 28px", maxHeight: "75vh", overflowY: "auto" }}>
            <div style={{ width: 40, height: 4, background: "#e0e0e0", borderRadius: 2, margin: "0 auto 16px" }} />
            <h3 style={{ fontSize: 17, fontWeight: 700, textAlign: "center", marginBottom: 4 }}>📷 要拍哪個科目？</h3>
            <p style={{ fontSize: 12, color: "#888", textAlign: "center", marginBottom: 18 }}>選擇後就能拍照 / 上傳</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {Object.entries(SUBJECTS).map(([key, val]) => (
                <button key={key}
                  onClick={() => { setSubject(key); setPickerOpen(false); setView("upload"); }}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px", border: "1px solid #eef0f4", borderRadius: 12, cursor: "pointer", background: "#fff", fontFamily: "inherit", textAlign: "left" }}>
                  <span style={{ fontSize: 22, width: 36, height: 36, borderRadius: 10, background: `${val.color}15`, color: val.color, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{val.icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{val.label}</span>
                </button>
              ))}
            </div>
            <button onClick={() => setPickerOpen(false)}
              style={{ width: "100%", marginTop: 14, padding: 12, border: "1px solid #ddd", borderRadius: 10, background: "#fff", fontFamily: "inherit", fontSize: 13, color: "#666", cursor: "pointer" }}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
  }

  if (view === "subject-home") {
    const subj = SUBJECTS[subject];
    if (!subj) { setView("home"); return null; }
    const subjNotes = notes.filter(n => n.subject === subject).sort((a, b) => (b.id || 0) - (a.id || 0));
    const subjStuck = stuckPoints.filter(p => p.subject === subject);
    const unresolvedStuck = subjStuck.filter(p => !p.resolved);
    const outlineUnits = (subj.outline || "").split("\n").map(s => s.trim()).filter(Boolean);

    return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

        {/* 科目專屬 Hero */}
        <div style={{ background: `linear-gradient(135deg,${subj.color},${subj.color}cc)`, color: "#fff", padding: "22px 20px 60px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: -40, right: -30, width: 160, height: 160, borderRadius: "50%", background: "#ffffff20" }} />
          <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "0 auto" }}>
            <Back />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
              <span style={{ fontSize: 36, width: 56, height: 56, borderRadius: 14, background: "#ffffff25", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{subj.icon}</span>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 900 }}>{subj.label}</h2>
                <p style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                  {subjNotes.length} 則筆記 · {unresolvedStuck.length} 個卡關 · {outlineUnits.length} 章節
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 主要 CTA + 編輯科目 */}
        <div style={{ maxWidth: 480, margin: "-42px auto 0", padding: "0 18px", position: "relative", zIndex: 2 }}>
          <button onClick={() => setView("upload")}
            style={{ width: "100%", padding: "16px 18px", border: "none", borderRadius: 14, cursor: "pointer", background: "#1a1a1a", color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 8px 24px rgba(0,0,0,0.15)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22 }}>📷</span>
              <span>拍照 / 上傳新題目</span>
            </span>
            <span style={{ fontSize: 18 }}>→</span>
          </button>

          <button onClick={() => { openSubjectEditor(subject); setView("subjects"); }}
            style={{ width: "100%", marginTop: 8, padding: "10px", border: "1px solid #eef0f4", borderRadius: 10, cursor: "pointer", background: "#fff", fontFamily: "inherit", fontSize: 12, color: "#666" }}>
            ⚙️ 編輯此科目（含大綱）
          </button>
        </div>

        <P>
          {/* 大綱概覽（若有；階層化呈現） */}
          {outlineUnits.length > 0 && (() => {
            const groups = parseOutline(subj.outline);
            return (
              <details style={{ marginTop: 18, background: "#fff", padding: "10px 14px 14px", borderRadius: 10, border: "1px solid #eef0f4" }}>
                <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#444" }}>
                  📋 課程大綱（{groups.filter(g => g.parent).length || groups.length} 章 · {outlineUnits.length} 項）
                </summary>
                <div style={{ marginTop: 10 }}>
                  {groups.map((g, gi) => (
                    <div key={gi} style={{ marginBottom: 10 }}>
                      {g.parent && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: subj.color, marginBottom: 6, paddingBottom: 4, borderBottom: `2px solid ${subj.color}25` }}>
                          <span style={{ width: 3, height: 14, background: subj.color, borderRadius: 2 }} />
                          {g.parent}
                        </div>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, paddingLeft: g.parent ? 9 : 0 }}>
                        {g.children.map(u => (
                          <span key={u} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 12, background: `${subj.color}10`, color: subj.color, border: `1px solid ${subj.color}25` }}>{u}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            );
          })()}

          {/* 此科目卡關 */}
          {unresolvedStuck.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#1a1a1a" }}>🚧 卡關（{unresolvedStuck.length}）</h3>
                <button onClick={() => setView("stuck")} style={{ fontSize: 11, color: "#1971C2", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>全部 →</button>
              </div>
              {unresolvedStuck.slice(0, 3).map(pt => (
                <div key={pt.id} style={{ background: "#fff", padding: "10px 12px", borderRadius: 10, border: "1px solid #eef0f4", marginBottom: 6, borderLeft: `3px solid ${subj.color}` }}>
                  {pt.unit && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: `${subj.color}15`, color: subj.color, marginRight: 6 }}>{pt.unit}</span>}
                  <span style={{ fontSize: 13, color: "#333" }}>{pt.summary}</span>
                </div>
              ))}
            </div>
          )}

          {/* 此科目歷史 */}
          <div style={{ marginTop: 18 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#1a1a1a", marginBottom: 8 }}>
              📖 學習紀錄（{subjNotes.length}）
            </h3>
            {subjNotes.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 20px", color: "#999", background: "#fff", borderRadius: 10, border: "1px dashed #e5e5e5" }}>
                <span style={{ fontSize: 32 }}>📭</span>
                <p style={{ marginTop: 8, fontSize: 13 }}>還沒有任何題目分析</p>
                <p style={{ fontSize: 11, color: "#bbb", marginTop: 4 }}>點上方「拍照 / 上傳新題目」開始</p>
              </div>
            ) : subjNotes.map(n => {
              const preview = (n.content || "").replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 70);
              return (
                <button key={n.id} onClick={() => { setSelectedNote(n); setView("history"); }}
                  style={{ width: "100%", textAlign: "left", background: "#fff", padding: "12px 14px", borderRadius: 10, border: "1px solid #eef0f4", marginBottom: 6, cursor: "pointer", fontFamily: "inherit", display: "block" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 6 }}>
                    <span style={{ fontSize: 11, color: "#999" }}>{n.timestamp}</span>
                    {n.unit && <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: `${subj.color}15`, color: subj.color, fontWeight: 500 }}>📍 {n.unit}</span>}
                  </div>
                  {n.title ? (
                    <p style={{ fontSize: 14, fontWeight: 600, color: "#1a1a1a", lineHeight: 1.4, margin: 0 }}>{n.title}</p>
                  ) : (
                    <p style={{ fontSize: 13, color: "#444", lineHeight: 1.5, margin: 0 }}>{preview}{preview.length >= 70 ? "..." : ""}</p>
                  )}
                </button>
              );
            })}
          </div>
        </P>
      </div>
    );
  }

  if (view === "upload") return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fillBar{from{width:0%}to{width:92%}}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <Back to="subject-home" />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <span style={{ fontSize: 28 }}>{SUBJECTS[subject]?.icon}</span>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>{SUBJECTS[subject]?.label}</h2>
        </div>

        {!image ? (
          <div>
            <div
              onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              style={{ marginTop: 20, padding: "32px 20px", border: `2px dashed ${isDragging ? SUBJECTS[subject]?.color : "#d6d6d6"}`, borderRadius: 16, textAlign: "center", background: isDragging ? `${SUBJECTS[subject]?.color}15` : "#fff", transition: "all 0.2s" }}>
              <span style={{ fontSize: 36, opacity: 0.5 }}>📋</span>
              <p style={{ fontSize: 14, color: "#888", marginTop: 8 }}>拖放圖片 / <strong>Ctrl+V</strong> 貼上截圖</p>
            </div>

            {/* 主要上傳按鈕（拍照 / 相簿）— 手機友善 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <label
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "18px 10px", border: "none", borderRadius: 14, cursor: "pointer", background: SUBJECTS[subject]?.color, color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 600, boxShadow: `0 4px 14px ${SUBJECTS[subject]?.color}40` }}>
                <span style={{ fontSize: 26 }}>📷</span>
                <span>拍照</span>
                <input type="file" accept="image/*" capture="environment" onChange={handleFilePick} style={{ display: "none" }} />
              </label>
              <label
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "18px 10px", border: `2px solid ${SUBJECTS[subject]?.color}`, borderRadius: 14, cursor: "pointer", background: "#fff", color: SUBJECTS[subject]?.color, fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>
                <span style={{ fontSize: 26 }}>🖼️</span>
                <span>從相簿選</span>
                <input type="file" accept="image/*" onChange={handleFilePick} style={{ display: "none" }} />
              </label>
            </div>

            <div style={{ textAlign: "center", margin: "16px 0 10px", fontSize: 12, color: "#bbb" }}>— 或 —</div>
            <button
              onClick={() => analyzeImage(true)}
              disabled={loading}
              style={{ width: "100%", padding: "12px", border: "1px dashed #d0d0d0", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500, background: "#fff", fontFamily: "inherit", color: "#666" }}>
              {loading ? <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span> 分析中...</span> : `🎮 用範例體驗（${SUBJECTS[subject]?.label}）`}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <img src={image} alt="preview" style={{ width: "100%", borderRadius: 10, border: "1px solid #e0e0e0" }} />
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button onClick={() => { setImage(null); setImageData(null); }} style={{ flex: 1, padding: "12px", border: "1px solid #ddd", borderRadius: 8, cursor: "pointer", background: "#fff", fontSize: 14, fontFamily: "inherit" }}>重選</button>
              <button onClick={() => analyzeImage(false)} disabled={loading}
                style={{ flex: 2, padding: "12px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 15, fontWeight: 600, fontFamily: "inherit", background: SUBJECTS[subject]?.color, opacity: loading ? 0.7 : 1 }}>
                {loading ? "分析中..." : "開始分析 →"}
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "#888" }}>☕ 辨識內容、檢查正確性、撰寫註解...</p>
            <div style={{ height: 3, background: "#eee", borderRadius: 2, marginTop: 10, overflow: "hidden" }}>
              <div style={{ height: "100%", background: "#2B8A3E", animation: "fillBar 6s ease-out forwards", borderRadius: 2 }} />
            </div>
          </div>
        )}
      </P>
    </div>
  );

  if (view === "result") {
    // sticky 頂部操作列需要的資料
    const latestNote = notes[0];
    const stickyTitle = latestNote?.title
      || (aiResult && aiResult.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "").slice(0, 30))
      || "未命名";
    const stickyUnit = latestNote?.unit || "";
    const handleSaveStuck = () => {
      if (savedToStuck || !aiResult) return;
      addStuckPoint({
        summary: stickyTitle,
        difficulty: 3,
        reviewTopic: "",
        unit: stickyUnit,
        question: stickyTitle,
        answer: aiResult,
      });
      setSavedToStuck(true);
    };
    const handleNextImage = () => {
      setView("upload"); setImage(null); setImageData(null); setAiResult(null); setFollowUp(null); setSavedToStuck(false);
    };
    return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Sticky 頂部操作列 */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(250,250,248,0.92)", backdropFilter: "blur(10px)", borderBottom: "1px solid #eef0f4" }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => { setView("home"); setImage(null); setImageData(null); setAiResult(null); setFollowUp(null); setSavedToStuck(false); }}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#666", padding: "4px 8px" }}>←</button>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {SUBJECTS[subject]?.icon} {stickyTitle}
          </span>
          <button onClick={handleSaveStuck} disabled={savedToStuck}
            title={savedToStuck ? "已加入卡關" : "加入卡關·之後複習"}
            style={{ padding: "6px 10px", border: `1px solid ${savedToStuck ? "#2B8A3E" : "#E8590C"}`, borderRadius: 8, background: savedToStuck ? "#E6F9E8" : "#FFF4E6", color: savedToStuck ? "#1B5E20" : "#BF360C", fontSize: 12, fontWeight: 600, cursor: savedToStuck ? "default" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {savedToStuck ? "✓ 已收藏" : "🚧 收藏"}
          </button>
          <button onClick={handleNextImage}
            title="分析下一張"
            style={{ padding: "6px 10px", border: "none", borderRadius: 8, background: "#1a1a1a", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            下一張 →
          </button>
        </div>
      </div>

      <P>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{SUBJECTS[subject]?.icon} 分析結果</h2>

        <div style={{ display: "flex", gap: 5, marginTop: 8, marginBottom: 6, flexWrap: "wrap" }}>
          {Object.entries(CONFIDENCE_STYLES).map(([k, v]) => (
            <span key={k} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 500, background: v.bg, color: v.text, border: `1px solid ${v.border}` }}>{v.label}</span>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "#888", marginBottom: 14, display: "flex", alignItems: "center", gap: 4 }}>
          <span>💾</span> 已自動保存至「歷史」
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {aiResult && renderAIContent(aiResult)}
        </div>

        <div style={{ marginTop: 22, padding: 14, background: "#F3EDE6", borderRadius: 10 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>🤔 有不懂的地方？</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={questionInput} onChange={(e) => setQuestionInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && askFollowUp()}
              placeholder="例如：為什麼分母是 2a？"
              style={{ flex: 1, padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", background: "#fff" }} />
            <button onClick={askFollowUp} disabled={askingAI}
              style={{ padding: "10px 16px", background: "#1971C2", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit", opacity: askingAI ? 0.7 : 1 }}>
              {askingAI ? "..." : "問"}
            </button>
          </div>

          {followUp && (
            <div style={{ marginTop: 12, padding: 12, background: "#fff", borderRadius: 8, border: "1px solid #e0e0e0" }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 6, fontWeight: 500 }}>AI 助教回答：</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {renderAIContent(followUp)}
              </div>
            </div>
          )}
        </div>

        <button onClick={handleNextImage}
          style={{ marginTop: 18, width: "100%", padding: "13px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 500, fontFamily: "inherit" }}>
          分析下一張 →
        </button>
      </P>
    </div>
    );
  }

  if (view === "subjects") {
    const counts = stuckPoints.reduce((acc, p) => {
      acc[p.subject] = (acc[p.subject] || 0) + 1;
      return acc;
    }, {});
    const editing = editingSubject !== null;

    return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <P>
          <Back />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700 }}>📚 科目管理</h2>
            {!editing && (
              <button onClick={() => openSubjectEditor("new")}
                style={{ padding: "6px 12px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                + 新增
              </button>
            )}
          </div>
          <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 14 }}>大學四年所有課程都加進來吧</p>

          {editing && (
            <div style={{ background: "#fff", padding: 16, borderRadius: 10, border: `2px solid ${subjectForm.color}`, marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                {editingSubject === "new" ? "新增科目" : "編輯科目"}
              </h3>

              <label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 4 }}>名稱</label>
              <input
                autoFocus
                value={subjectForm.label}
                onChange={(e) => setSubjectForm({ ...subjectForm, label: e.target.value })}
                placeholder="例如：微積分、計算機概論"
                maxLength={20}
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #ddd", borderRadius: 6, fontSize: 14, fontFamily: "inherit", outline: "none", marginBottom: 12 }}
              />

              <label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 4 }}>圖示（單一字元或 emoji）</label>
              <input
                value={subjectForm.icon}
                onChange={(e) => setSubjectForm({ ...subjectForm, icon: e.target.value.slice(0, 2) })}
                placeholder="📘"
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #ddd", borderRadius: 6, fontSize: 18, fontFamily: "inherit", outline: "none", marginBottom: 12 }}
              />

              <label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 6 }}>顏色</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                {SUBJECT_COLORS.map((c) => (
                  <button key={c} onClick={() => setSubjectForm({ ...subjectForm, color: c })}
                    style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: subjectForm.color === c ? "3px solid #1a1a1a" : "2px solid #fff", boxShadow: "0 0 0 1px #ddd", cursor: "pointer" }} />
                ))}
              </div>

              <label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 4 }}>
                📋 大綱 / 章節（可選，每行一個單元）
              </label>

              {/* 拍照識別大綱（支援多張） */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", border: `1.5px dashed ${subjectForm.color}`, borderRadius: 8, cursor: outlineExtracting ? "wait" : "pointer", background: outlineExtracting ? "#f5f5f5" : `${subjectForm.color}08`, color: subjectForm.color, fontFamily: "inherit", fontSize: 13, fontWeight: 600, marginBottom: 8, opacity: outlineExtracting ? 0.7 : 1 }}>
                <span style={{ fontSize: 18 }}>{outlineExtracting ? "◌" : "📷"}</span>
                <span>
                  {outlineExtracting
                    ? (outlineProgress.total > 0
                        ? `AI 正在分析 ${outlineProgress.total} 張圖片...（約 ${Math.max(5, outlineProgress.total * 4)} 秒）`
                        : "讀取圖片中...")
                    : "拍照識別大綱（可選多張）"}
                </span>
                <input type="file" accept="image/*" multiple disabled={outlineExtracting}
                  onChange={(e) => { extractOutlineFromImages(e.target.files); e.target.value = ""; }}
                  style={{ display: "none" }} />
              </label>

              <textarea
                value={subjectForm.outline || ""}
                onChange={(e) => setSubjectForm({ ...subjectForm, outline: e.target.value })}
                placeholder={"例如：\nCh.1 微分基礎\nCh.2 積分技巧\nCh.3 級數收斂\nCh.4 多變數函數"}
                rows={6}
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, fontFamily: "inherit", outline: "none", marginBottom: 6, resize: "vertical", lineHeight: 1.6 }}
              />
              <p style={{ fontSize: 11, color: "#999", marginBottom: 14, lineHeight: 1.5 }}>
                💡 拍照課本目錄頁、課程大綱投影片，AI 會自動整理。之後問問題會自動歸類，可手動更正。
              </p>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setEditingSubject(null)}
                  style={{ flex: 1, padding: "10px", border: "1px solid #ddd", borderRadius: 6, cursor: "pointer", background: "#fff", fontSize: 13, fontFamily: "inherit" }}>
                  取消
                </button>
                {editingSubject !== "new" && (
                  <button onClick={() => deleteSubject(editingSubject)}
                    style={{ flex: 1, padding: "10px", border: "1px solid #C62828", borderRadius: 6, cursor: "pointer", background: "#fff", color: "#C62828", fontSize: 13, fontFamily: "inherit" }}>
                    刪除
                  </button>
                )}
                <button onClick={saveSubject} disabled={!subjectForm.label.trim()}
                  style={{ flex: 1.5, padding: "10px", border: "none", borderRadius: 6, cursor: "pointer", background: subjectForm.color, color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", opacity: subjectForm.label.trim() ? 1 : 0.5 }}>
                  儲存
                </button>
              </div>
            </div>
          )}

          {Object.entries(SUBJECTS).map(([key, val]) => (
            <div key={key}
              onClick={() => !editing && openSubjectEditor(key)}
              style={{ background: "#fff", padding: "12px 14px", borderRadius: 8, border: "1px solid #eee", marginBottom: 8, borderLeft: `4px solid ${val.color}`, cursor: editing ? "default" : "pointer", display: "flex", alignItems: "center", gap: 12, opacity: editing && editingSubject !== key ? 0.5 : 1 }}>
              <span style={{ fontSize: 24 }}>{val.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{val.label}</div>
                <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{counts[key] || 0} 個卡關紀錄</div>
              </div>
              {!editing && <span style={{ color: "#bbb", fontSize: 18 }}>›</span>}
            </div>
          ))}

          {Object.keys(SUBJECTS).length === 0 && !editing && (
            <div style={{ textAlign: "center", padding: "44px 20px", color: "#777" }}>
              <span style={{ fontSize: 44 }}>📚</span>
              <p style={{ marginTop: 10 }}>還沒有科目，點右上「+ 新增」開始吧</p>
            </div>
          )}

          {/* 資料備份／還原 */}
          {!editing && (
            <div style={{ marginTop: 28, padding: "14px 16px", background: "#fff", borderRadius: 12, border: "1px solid #eef0f4" }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>💾 資料備份</h3>
              <p style={{ fontSize: 11, color: "#888", marginBottom: 12, lineHeight: 1.6 }}>
                資料只存在這個瀏覽器，清快取或換裝置都會消失。<br/>建議定期匯出 JSON 備份。
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={exportData}
                  style={{ flex: 1, padding: "10px", border: "1px solid #1971C2", borderRadius: 8, background: "#fff", color: "#1971C2", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  ⬇ 匯出備份
                </button>
                <label style={{ flex: 1, padding: "10px", border: "1px solid #2B8A3E", borderRadius: 8, background: "#fff", color: "#2B8A3E", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                  ⬆ 合併匯入
                  <input type="file" accept="application/json,.json" style={{ display: "none" }}
                    onChange={(e) => { importData(e.target.files?.[0], "merge"); e.target.value = ""; }} />
                </label>
              </div>
              <label style={{ display: "block", marginTop: 8, padding: "8px", border: "1px dashed #C62828", borderRadius: 8, background: "#fff", color: "#C62828", fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                ⚠ 完整還原（會覆蓋現有資料）
                <input type="file" accept="application/json,.json" style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file && confirm("確定要用備份檔覆蓋現有資料嗎？這個動作無法復原。")) importData(file, "replace");
                  }} />
              </label>
            </div>
          )}
        </P>
      </div>
    );
  }

  if (view === "stuck") {
    const filteredStuck = stuckPoints.filter(pt => {
      if (stuckFilter === "unresolved") return !pt.resolved;
      if (stuckFilter === "due") return !pt.resolved && isDue(pt);
      if (stuckFilter === "resolved") return pt.resolved;
      return true; // all
    });
    const deleteStuck = (id) => {
      if (!window.confirm("\u78ba\u5b9a\u8981\u522a\u9664\u9019\u500b\u5361\u95dc\u9ede\u55ce\uff1f\u9023\u540c\u8907\u7fd2\u6392\u7a0b\u4e00\u8d77\u522a\u9664\uff0c\u7121\u6cd5\u5fa9\u539f\u3002")) return;
      setStuckPoints(prev => prev.filter(p => p.id !== id));
    };
    return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <Back />
        <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>🚧 卡關大全</h2>
        <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 12 }}>所有「不懂」集中在這裡</p>

        {/* #5 \u7be9\u9078 chip */}
        {stuckPoints.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {[
              { key: "unresolved", label: "\u672a\u89e3", count: stuckPoints.filter(p => !p.resolved).length },
              { key: "due", label: "\u4eca\u65e5\u5230\u671f", count: stuckPoints.filter(p => !p.resolved && isDue(p)).length },
              { key: "resolved", label: "\u5df2\u641e\u61c2", count: stuckPoints.filter(p => p.resolved).length },
              { key: "all", label: "\u5168\u90e8", count: stuckPoints.length },
            ].map(c => {
              const active = stuckFilter === c.key;
              return (
                <button key={c.key} onClick={() => setStuckFilter(c.key)}
                  style={{ padding: "5px 12px", borderRadius: 999, border: active ? "1px solid #1a1a1a" : "1px solid #e0e3e8", background: active ? "#1a1a1a" : "#fff", color: active ? "#fff" : "#666", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {c.label} <span style={{ opacity: 0.6, marginLeft: 2 }}>{c.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {stuckPoints.length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 20px", color: "#777" }}>
            <span style={{ fontSize: 44 }}>🎯</span>
            <p style={{ marginTop: 10, fontWeight: 500 }}>還沒有卡關紀錄</p>
            <p style={{ fontSize: 13, color: "#999", marginTop: 4 }}>分析筆記後對不懂的地方提問，就會記錄在這</p>
          </div>
        ) : filteredStuck.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 20px", color: "#777" }}>
            <span style={{ fontSize: 36 }}>\ud83d\udd0d</span>
            <p style={{ marginTop: 8, fontSize: 13 }}>\u9019\u500b\u7be9\u9078\u4e0b\u6c92\u6709\u7d50\u679c</p>
          </div>
        ) : filteredStuck.map((pt) => {
          const subj = SUBJECTS[pt.subject];
          const outlineGroups = parseOutline(subj?.outline);
          const units = outlineGroups.flatMap(g => g.children);
          const updateUnit = (newUnit) => {
            setStuckPoints(prev => prev.map(p => p.id === pt.id ? { ...p, unit: newUnit } : p));
          };
          const unitOptions = outlineGroups.map((g, gi) =>
            g.parent
              ? <optgroup key={gi} label={g.parent}>{g.children.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
              : g.children.map(u => <option key={u} value={u}>{u}</option>)
          );
          return (
          <div key={pt.id} style={{ background: "#fff", padding: "12px 14px", borderRadius: 10, border: "1px solid #eef0f4", marginBottom: 10, borderLeft: `4px solid ${subj?.color || "#999"}`, opacity: pt.resolved ? 0.5 : 1, boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#777" }}>{subj?.label}</span>
              <div style={{ display: "flex", gap: 3 }}>
                {[1, 2, 3, 4, 5].map(d => <span key={d} style={{ width: 7, height: 7, borderRadius: "50%", background: d <= pt.difficulty ? subj?.color : "#ddd", display: "inline-block" }} />)}
              </div>
            </div>
            {pt.unit && (
              units.length > 0 ? (
                <select value={pt.unit} onChange={(e) => updateUnit(e.target.value)}
                  style={{ marginTop: 6, fontSize: 11, padding: "2px 6px", borderRadius: 4, border: `1px solid ${subj?.color}40`, background: `${subj?.color}10`, color: subj?.color, fontFamily: "inherit", cursor: "pointer", maxWidth: "100%" }}>
                  {!units.includes(pt.unit) && <option value={pt.unit}>{pt.unit}（不在大綱）</option>}
                  {unitOptions}
                  <option value="">— 未分類 —</option>
                </select>
              ) : (
                <span style={{ display: "inline-block", marginTop: 6, fontSize: 11, padding: "2px 8px", borderRadius: 4, background: `${subj?.color}15`, color: subj?.color }}>📍 {pt.unit}</span>
              )
            )}
            {!pt.unit && units.length > 0 && (
              <select value="" onChange={(e) => updateUnit(e.target.value)}
                style={{ marginTop: 6, fontSize: 11, padding: "2px 6px", borderRadius: 4, border: "1px dashed #ccc", background: "#fafafa", color: "#888", fontFamily: "inherit", cursor: "pointer" }}>
                <option value="">📍 指定單元...</option>
                {unitOptions}
              </select>
            )}
            <p style={{ fontSize: 14, fontWeight: 500, marginTop: 6, lineHeight: 1.5 }}>{pt.summary}</p>
            {pt.reviewTopic && <p style={{ fontSize: 12, color: "#1971C2", marginTop: 4 }}>📚 {pt.reviewTopic}</p>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#bbb" }}>{pt.timestamp} · {pt.resolved ? "已搞懂" : formatDueLabel(pt)}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setStuckPoints(prev => prev.map(p => p.id === pt.id ? { ...p, resolved: !p.resolved } : p))}
                  style={{ padding: "4px 10px", border: "1px solid #ddd", borderRadius: 5, cursor: "pointer", background: "#fff", fontSize: 11, fontFamily: "inherit" }}>
                  {pt.resolved ? "↩ 再看看" : "✓ 搞懂了"}
                </button>
                {/* #6 \u522a\u9664 */}
                <button onClick={() => deleteStuck(pt.id)} title="\u522a\u9664"
                  style={{ padding: "4px 8px", border: "1px solid #ffe0e0", borderRadius: 5, cursor: "pointer", background: "#fff5f5", color: "#C62828", fontSize: 11, fontFamily: "inherit" }}>
                  \ud83d\uddd1
                </button>
              </div>
            </div>
          </div>
        );})}
      </P>
    </div>
  );
  }

  if (view === "history") {
    // 依日期降序 + 搜尋過濾，依科目分組
    const q = historySearch.trim().toLowerCase();
    const oneWeekAgo = Date.now() - 7 * DAY_MS;
    const filteredNotes = [...notes]
      .filter(n => {
        // \u6587\u5b57\u641c\u5c0b
        if (q) {
          const haystack = `${n.title || ""} ${n.unit || ""} ${n.content || ""} ${SUBJECTS[n.subject]?.label || ""}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        // chip \u7be9\u9078
        if (historyFilter === "week") return (n.id || 0) > oneWeekAgo;
        if (historyFilter === "lowconf") return /\u5efa\u8b70\u81ea\u884c\u8a08\u7b97|\u9700\u9a57\u8b49/.test(n.content || "");
        return true;
      })
      .sort((a, b) => (b.id || 0) - (a.id || 0));
    const grouped = filteredNotes.reduce((acc, n) => {
      const key = n.subject || "_other";
      (acc[key] = acc[key] || []).push(n);
      return acc;
    }, {});

    // #6 \u522a\u9664\u55ae\u7b46\u6b77\u53f2
    const deleteNote = (id) => {
      if (!window.confirm("\u78ba\u5b9a\u8981\u522a\u9664\u9019\u7b46\u7b46\u8a18\u55ce\uff1f\u9019\u500b\u52d5\u4f5c\u7121\u6cd5\u5fa9\u539f\u3002")) return;
      setNotes(prev => prev.filter(n => n.id !== id));
      if (selectedNote?.id === id) setSelectedNote(null);
    };

    return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <P>
          <Back />
          <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>📖 學習歷史</h2>
          <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 12 }}>所有分析過的內容都在這</p>

          {/* 搜尋框（detail view 時隱藏） */}
          {!selectedNote && notes.length > 0 && (
            <div style={{ position: "relative", marginBottom: 14 }}>
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#aaa" }}>🔍</span>
              <input
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="搜尋標題、單元、內文..."
                style={{ width: "100%", padding: "10px 38px 10px 36px", border: "1px solid #e0e3e8", borderRadius: 10, fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff" }}
              />
              {historySearch && (
                <button onClick={() => setHistorySearch("")}
                  style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", fontSize: 16, color: "#999", cursor: "pointer", padding: 4, lineHeight: 1 }}>×</button>
              )}
            </div>
          )}

          {/* #5 \u7be9\u9078 chip */}
          {!selectedNote && notes.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              {[
                { key: "all", label: "\u5168\u90e8", count: notes.length },
                { key: "week", label: "\u672c\u9031", count: notes.filter(n => (n.id || 0) > oneWeekAgo).length },
                { key: "lowconf", label: "\u9700\u9a57\u8b49", count: notes.filter(n => /\u5efa\u8b70\u81ea\u884c\u8a08\u7b97|\u9700\u9a57\u8b49/.test(n.content || "")).length },
              ].map(c => {
                const active = historyFilter === c.key;
                return (
                  <button key={c.key} onClick={() => setHistoryFilter(c.key)}
                    style={{ padding: "5px 12px", borderRadius: 999, border: active ? "1px solid #1a1a1a" : "1px solid #e0e3e8", background: active ? "#1a1a1a" : "#fff", color: active ? "#fff" : "#666", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                    {c.label} <span style={{ opacity: 0.6, marginLeft: 2 }}>{c.count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {selectedNote ? (
            <div>
              <button onClick={() => setSelectedNote(null)}
                style={{ background: "none", border: "none", fontSize: 13, color: "#888", cursor: "pointer", padding: 0, marginBottom: 10, fontFamily: "inherit" }}>
                ← 返回歷史列表
              </button>
              <div style={{ background: "#fff", padding: 16, borderRadius: 12, border: "1px solid #eef0f4", boxShadow: "0 2px 8px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>
                  <span style={{ fontSize: 20 }}>{SUBJECTS[selectedNote.subject]?.icon || "📘"}</span>
                  <div style={{ flex: 1 }}>
                    {selectedNote.title && <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a1a", marginBottom: 2 }}>{selectedNote.title}</div>}
                    <div style={{ fontSize: 11, color: "#999", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>{SUBJECTS[selectedNote.subject]?.label || "未分類"}</span>
                      <span>·</span>
                      <span>{selectedNote.timestamp}</span>
                      {selectedNote.unit && (
                        <span style={{ padding: "2px 7px", borderRadius: 4, background: `${SUBJECTS[selectedNote.subject]?.color || "#999"}15`, color: SUBJECTS[selectedNote.subject]?.color || "#999", fontWeight: 500 }}>📍 {selectedNote.unit}</span>
                      )}
                    </div>
                  </div>
                  {/* #6 \u522a\u9664 */}
                  <button onClick={() => deleteNote(selectedNote.id)} title="\u522a\u9664\u9019\u7b46\u7d00\u9304"
                    style={{ background: "#fff5f5", border: "1px solid #ffe0e0", color: "#C62828", padding: "5px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    \ud83d\uddd1 \u522a\u9664
                  </button>
                </div>
                {renderAIContent(selectedNote.content || "")}
              </div>
            </div>
          ) : notes.length === 0 ? (
            <div style={{ textAlign: "center", padding: "44px 20px", color: "#777" }}>
              <span style={{ fontSize: 44 }}>📖</span>
              <p style={{ marginTop: 10, fontWeight: 500 }}>還沒有任何紀錄</p>
              <p style={{ fontSize: 13, color: "#999", marginTop: 4 }}>分析過的圖片會自動存到這裡</p>
            </div>
          ) : filteredNotes.length === 0 ? (
            <div style={{ textAlign: "center", padding: "44px 20px", color: "#777" }}>
              <span style={{ fontSize: 44 }}>🔍</span>
              <p style={{ marginTop: 10, fontWeight: 500 }}>找不到符合「{historySearch}」的紀錄</p>
              <button onClick={() => setHistorySearch("")} style={{ marginTop: 10, padding: "6px 14px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>清除搜尋</button>
            </div>
          ) : (
            Object.entries(grouped).map(([sKey, list]) => (
              <div key={sKey} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ width: 4, height: 16, background: SUBJECTS[sKey]?.color || "#999", borderRadius: 2 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#444" }}>
                    {SUBJECTS[sKey]?.icon} {SUBJECTS[sKey]?.label || "未分類"}
                  </span>
                  <span style={{ fontSize: 11, color: "#999" }}>· {list.length} 則</span>
                </div>
                {list.map((n) => {
                  const subjColor = SUBJECTS[sKey]?.color || "#999";
                  const preview = (n.content || "").replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 60);
                  return (
                    <div key={n.id} style={{ position: "relative", marginBottom: 8 }}>
                      <button onClick={() => setSelectedNote(n)}
                        style={{ width: "100%", textAlign: "left", background: "#fff", padding: "12px 38px 12px 14px", borderRadius: 10, border: "1px solid #eef0f4", cursor: "pointer", fontFamily: "inherit", display: "block", boxShadow: "0 2px 6px rgba(0,0,0,0.02)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 6 }}>
                          <span style={{ fontSize: 11, color: "#999" }}>{n.timestamp}</span>
                          {n.unit && <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: `${subjColor}15`, color: subjColor, fontWeight: 500 }}>\ud83d\udccd {n.unit}</span>}
                        </div>
                        {n.title ? (
                          <p style={{ fontSize: 14, fontWeight: 600, color: "#1a1a1a", lineHeight: 1.4, margin: 0 }}>{n.title}</p>
                        ) : (
                          <p style={{ fontSize: 13, color: "#444", lineHeight: 1.5, margin: 0 }}>{preview}{preview.length >= 60 ? "..." : ""}</p>
                        )}
                      </button>
                      {/* #6 \u522a\u9664\u6309\u9215 */}
                      <button onClick={(e) => { e.stopPropagation(); deleteNote(n.id); }}
                        title="\u522a\u9664"
                        style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, border: "none", borderRadius: 6, background: "transparent", color: "#bbb", fontSize: 14, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "#fff5f5"; e.currentTarget.style.color = "#C62828"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#bbb"; }}>
                        \u00d7
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </P>
      </div>
    );
  }

  if (view === "review") {
    const unresolved = stuckPoints
      .filter(p => !p.resolved && isDue(p))
      .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));

    // #3 \u5168\u90e8\u8907\u7fd2\u5b8c\u6210 \u2192 \u6176\u795d\u756b\u9762
    if (unresolved.length === 0) {
      const { total, correct, fuzzy, wrong } = reviewSession;
      // 7 \u65e5\u71b1\u529b\u5716\uff1a\u4ee5 lastReviewedAt \u7d71\u8a08
      const today = new Date(); today.setHours(0,0,0,0);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(today.getDate() - (6 - i));
        return d.getTime();
      });
      const dayCounts = days.map(start => {
        const end = start + DAY_MS;
        return stuckPoints.filter(p => p.lastReviewedAt && p.lastReviewedAt >= start && p.lastReviewedAt < end).length;
      });
      const maxCount = Math.max(1, ...dayCounts);
      const totalSolved = stuckPoints.filter(p => p.resolved).length;
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

      // \u9032\u5165\u6176\u795d\u756b\u9762\u5f8c\u91cd\u7f6e session\uff08\u4e0b\u6b21\u9032\u5165 review \u624d\u91cd\u65b0\u8a08\uff09
      // \u4f7f\u7528 setTimeout \u907f\u514d render \u4e2d\u8a2d\u5b58
      if (reviewSession.active && reviewSession.finishedAt == null) {
        setTimeout(() => setReviewSession(s => ({ ...s, finishedAt: Date.now() })), 0);
      }

      return (
        <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "linear-gradient(180deg,#FFF8E1 0%,#FAFAF8 240px)" }}>
          <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes pop{0%{transform:scale(0.5);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}@keyframes shine{0%,100%{transform:rotate(0deg)}50%{transform:rotate(8deg)}}`}</style>
          <P>
            <Back />
            <div style={{ textAlign: "center", padding: "20px 8px 0" }}>
              <div style={{ fontSize: 72, animation: "pop 0.5s ease-out", display: "inline-block" }}>
                <span style={{ display: "inline-block", animation: "shine 1.6s ease-in-out infinite" }}>\ud83c\udf89</span>
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 900, marginTop: 10, color: "#1a1a1a" }}>
                {total > 0 ? "\u672c\u56de\u5408\u5b8c\u6210\uff01" : "\u4eca\u65e5\u8907\u7fd2\u5b8c\u6210\uff01"}
              </h2>
              <p style={{ fontSize: 13, color: "#888", marginTop: 6 }}>
                {total > 0 ? "\u4f60\u662f\u73a9\u771f\u7684\u3002\u660e\u5929\u898b\uff5e\ud83d\udc4b" : "\u4e0b\u4e00\u5f35\u5361\u7247\u6703\u5728\u6392\u7a0b\u6642\u9593\u5230\u9054\u5f8c\u51fa\u73fe"}
              </p>
            </div>

            {/* \u672c\u56de\u5408\u7d71\u8a08\uff08\u53ea\u5728\u6709\u8a55\u5206\u904e\u624d\u986f\u793a\uff09 */}
            {total > 0 && (
              <div style={{ marginTop: 22, background: "#fff", padding: "16px 14px", borderRadius: 14, boxShadow: "0 4px 16px rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize: 12, color: "#888", textAlign: "center", marginBottom: 10 }}>\u9019\u4e00\u56de\u5408</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, textAlign: "center" }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#1971C2" }}>{total}</div>
                    <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>\u5f9e\u8907\u7fd2</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#2B8A3E" }}>{correct}</div>
                    <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>\u2705 \u61c2\u4e86</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#E8590C" }}>{fuzzy}</div>
                    <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>\ud83e\udd14 \u6a21\u7cca</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#C62828" }}>{wrong}</div>
                    <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>\ud83d\ude35 \u4e0d\u61c2</div>
                  </div>
                </div>
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #f0f0f0", textAlign: "center" }}>
                  <span style={{ fontSize: 12, color: "#666" }}>\u638c\u63e1\u5ea6 </span>
                  <span style={{ fontSize: 18, fontWeight: 900, color: accuracy >= 70 ? "#2B8A3E" : accuracy >= 40 ? "#E8590C" : "#C62828" }}>{accuracy}%</span>
                </div>
              </div>
            )}

            {/* 7 \u65e5\u71b1\u529b\u5716 */}
            <div style={{ marginTop: 18, background: "#fff", padding: "14px", borderRadius: 14, boxShadow: "0 4px 16px rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>\u8fd1 7 \u65e5\u8907\u7fd2\u8db3\u8de1</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
                {days.map((d, i) => {
                  const c = dayCounts[i];
                  const intensity = c / maxCount;
                  const bg = c === 0 ? "#f0f0f0" : `rgba(43,138,62,${0.25 + intensity * 0.75})`;
                  const dateStr = new Date(d).getDate();
                  const isToday = i === 6;
                  return (
                    <div key={d} style={{ textAlign: "center" }}>
                      <div style={{ height: 32, borderRadius: 6, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: c > 0 ? "#fff" : "#bbb", border: isToday ? "2px solid #1a1a1a" : "none" }}>
                        {c || ""}
                      </div>
                      <div style={{ fontSize: 9, color: "#aaa", marginTop: 3 }}>{dateStr}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* \u7e3d\u9ad4\u7a4d\u7d2f */}
            <div style={{ marginTop: 18, background: "#fff", padding: "12px 14px", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 11, color: "#888" }}>\u7d2f\u7a4d\u514b\u670d\u5361\u95dc</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: "#2B8A3E", marginTop: 2 }}>{totalSolved} <span style={{ fontSize: 12, color: "#999", fontWeight: 400 }}>/ {stuckPoints.length}</span></div>
              </div>
              <span style={{ fontSize: 32 }}>\ud83d\udcaa</span>
            </div>

            <button onClick={() => { setReviewSession({ active: false, total: 0, correct: 0, fuzzy: 0, wrong: 0, finishedAt: null }); setView("home"); }}
              style={{ width: "100%", marginTop: 18, padding: "13px", border: "none", borderRadius: 10, cursor: "pointer", background: "#1a1a1a", color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "inherit" }}>
              \u56de\u9996\u9801
            </button>
          </P>
        </div>
      );
    }

    const card = unresolved[currentCard % unresolved.length];

    const handleGrade = (quality) => {
      setStuckPoints(prev => prev.map(p => p.id === card.id ? gradeCard(p, quality) : p));
      setReviewSession(s => ({
        ...s,
        active: true,
        total: s.total + 1,
        correct: quality === 5 ? s.correct + 1 : s.correct,
        fuzzy: quality === 3 ? s.fuzzy + 1 : s.fuzzy,
        wrong: quality < 3 ? s.wrong + 1 : s.wrong,
      }));
      setShowAnswer(false);
      setCurrentCard(c => c + 1);
    };
    const handleSkip = () => { setShowAnswer(false); setCurrentCard(c => c + 1); };

    return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        {/* #1 \u9023\u52d5\u9375\u76e4\u5feb\u6377\u9375 */}
        <KeyboardBridge onGrade={handleGrade} onSkip={handleSkip} />
        <P>
          <Back />
          <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12, textAlign: "center" }}>🔄 間隔複習</h2>
          <p style={{ textAlign: "center", fontSize: 13, color: "#888", marginBottom: 10 }}>
            {currentCard % unresolved.length + 1} / {unresolved.length}
            {reviewSession.total > 0 && <span style={{ marginLeft: 8, color: "#bbb" }}>· 已答 {reviewSession.total}</span>}
          </p>
          {/* \u9032\u5ea6\u689d */}
          <div style={{ height: 4, background: "#eee", borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, ((currentCard % unresolved.length) / unresolved.length) * 100)}%`, background: "linear-gradient(90deg,#1971C2,#5F3DC4)", transition: "width 0.3s ease" }} />
          </div>

          <div onClick={() => setShowAnswer(!showAnswer)}
            style={{ background: "#fff", padding: "28px 20px", borderRadius: 12, border: "1px solid #e8e8e8", borderTop: `4px solid ${SUBJECTS[card.subject]?.color}`, minHeight: 180, cursor: "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#999" }}>{SUBJECTS[card.subject]?.label}</span>
            <p style={{ fontSize: 16, fontWeight: 500, marginTop: 12, lineHeight: 1.6 }}>{card.question || card.summary}</p>
            {!showAnswer ? (
              <p style={{ marginTop: 20, fontSize: 13, color: "#ccc" }}>\ud83d\udc46 \u9ede\u64ca\u770b\u89e3\u7b54 <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>(Space)</span></p>
            ) : (
              <div onClick={(e) => e.stopPropagation()}
                style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #eee", textAlign: "left", width: "100%", maxHeight: "60vh", overflowY: "auto" }}>
                {/* 若 answer 是當初 AI 完整解答 → 套用排版；否則 fallback 到 summary */}
                {card.answer && card.answer.trim() && card.answer !== card.summary ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{renderAIContent(card.answer)}</div>
                ) : (
                  <p style={{ fontSize: 14, lineHeight: 1.6, color: "#444" }}>
                    <RenderWithMath text={card.summary || "（沒有更多內容）"} />
                  </p>
                )}
                {card.reviewTopic && <p style={{ fontSize: 13, color: "#1971C2", marginTop: 8 }}>📚 {card.reviewTopic}</p>}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button onClick={() => handleGrade(0)} title="\u5feb\u6377\u9375 1" style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#C62828" }}>\ud83d\ude35 \u4e0d\u61c2<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>10 \u5206\u9418\u5f8c \u00b7 1</div></button>
            <button onClick={() => handleGrade(3)} title="\u5feb\u6377\u9375 2" style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#E8590C" }}>\ud83e\udd14 \u6a21\u7cca<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>\u660e\u5929 \u00b7 2</div></button>
            <button onClick={() => handleGrade(5)} title="\u5feb\u6377\u9375 3" style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#2B8A3E" }}>\u2705 \u61c2\u4e86<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>\u62c9\u9577\u9593\u9694 \u00b7 3</div></button>
          </div>

          {/* #9 \u8df3\u904e\uff08\u4e0d\u5beb\u5165 SRS\uff09 */}
          <button onClick={handleSkip}
            title="\u5feb\u6377\u9375 S\uff1a\u770b\u4e0b\u4e00\u5f35\u4e0d\u8a55\u5206\uff0c\u4e0d\u5f71\u97ff\u8907\u7fd2\u6392\u7a0b"
            style={{ width: "100%", marginTop: 8, padding: "10px", border: "1px solid #ddd", borderRadius: 8, background: "#fff", color: "#888", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>
            \u23ed \u770b\u4e0b\u4e00\u5f35\uff08\u4e0d\u8a55\u5206 \u00b7 S\uff09
          </button>

          {/* \u684c\u9762\u63d0\u793a */}
          <p style={{ fontSize: 10, color: "#bbb", textAlign: "center", marginTop: 14 }}>
            \ud83d\udcbb \u684c\u9762\u5feb\u6377\u9375\uff1aSpace \u7ffb\u9762 \u00b7 1/2/3 \u8a55\u5206 \u00b7 S \u8df3\u904e
          </p>
        </P>
      </div>
    );
  }

  return null;
}
