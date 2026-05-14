import { useState, useRef, useEffect, useCallback } from "react";

// ===== Backend Proxy =====
// 部署 study-companion-proxy 後填入；本機開發改成 http://localhost:8787
const PROXY_URL = import.meta.env?.VITE_PROXY_URL || "https://study-companion-proxy.<your-subdomain>.workers.dev";
const APP_TOKEN = import.meta.env?.VITE_APP_TOKEN || "";

async function callClaude(payload) {
  const headers = { "Content-Type": "application/json" };
  if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error || ""; } catch {}
    throw new Error(`Proxy ${response.status}: ${detail || response.statusText}`);
  }
  return response.json();
}

const DEFAULT_SUBJECTS = {
  math: { label: "數學", icon: "∑", color: "#E8590C" },
  electronics: { label: "電子學", icon: "⚡", color: "#2B8A3E" },
  electrical: { label: "電學", icon: "🔌", color: "#1971C2" },
  digital: { label: "數位邏輯", icon: "⬡", color: "#9C36B5" },
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
    return {
      stuckPoints: Array.isArray(parsed.stuckPoints) ? parsed.stuckPoints : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      subjects: parsed.subjects && typeof parsed.subjects === "object" && Object.keys(parsed.subjects).length > 0
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
  } catch (e) {
    console.warn("無法寫入 localStorage：", e);
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
  const [subjectForm, setSubjectForm] = useState({ label: "", icon: "📘", color: SUBJECT_COLORS[0] });

  // 自動持久化
  useEffect(() => {
    saveState(stuckPoints, notes, subjects);
  }, [stuckPoints, notes, subjects]);

  // 別名：保留原本 SUBJECTS 名稱以最小化變動
  const SUBJECTS = subjects;

  const openSubjectEditor = (key) => {
    if (key === "new") {
      setSubjectForm({
        label: "",
        icon: "📘",
        color: SUBJECT_COLORS[Object.keys(subjects).length % SUBJECT_COLORS.length],
      });
    } else {
      setSubjectForm({ ...subjects[key] });
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

  const addStuckPoint = (point) => {
    setStuckPoints((prev) => [{
      id: Date.now(), ...point, subject, timestamp: new Date().toLocaleDateString("zh-TW"), resolved: false,
      ...initSRS(),
    }, ...prev]);
  };

  const addNote = (note) => {
    setNotes((prev) => [{ id: Date.now(), ...note, subject, timestamp: new Date().toLocaleDateString("zh-TW") }, ...prev]);
  };

  const processFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImage(ev.target.result);
      setImageData(ev.target.result.split(",")[1]);
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

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) processFile(files[0]);
  }, [processFile]);

  const analyzeImage = async (useDemo = false) => {
    if (!useDemo && !imageData) return;
    setLoading(true);
    setAiResult(null);

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
      const data = await callClaude({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } },
            { type: "text", text: `你是一位${subjectLabel}學習助教。請分析這張筆記/課程頁面的圖片，請用繁體中文回答：

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
      setAiResult(text);
      addNote({ content: text, type: "analysis" });
      setView("result");
    } catch (err) {
      setAiResult("分析時發生錯誤：" + err.message);
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
      const data = await callClaude({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
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
建議複習：[相關概念]`,
        }],
      });
      const text = data.content?.map((c) => c.text || "").join("\n") || "無法回答";
      setFollowUp(text);

      const summaryMatch = text.match(/卡關摘要：(.+)/);
      const difficultyMatch = text.match(/難度：(\d)/);
      const reviewMatch = text.match(/建議複習：(.+)/);
      if (summaryMatch) {
        addStuckPoint({
          summary: summaryMatch[1].trim(),
          difficulty: difficultyMatch ? parseInt(difficultyMatch[1]) : 3,
          reviewTopic: reviewMatch ? reviewMatch[1].trim() : "",
          question: q,
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
    return text.split("\n").map((line, i) => {
      if (!line.trim()) return null;
      const isH2 = line.startsWith("## ");
      const isError = line.startsWith("❌");
      const isWarn = line.startsWith("⚠");
      const isTip = line.startsWith("💡");

      const hasHigh = line.includes("[高信心]");
      const hasMed = line.includes("[需驗證]");
      const hasLow = line.includes("[建議自行計算]");
      const conf = hasHigh ? "high" : hasMed ? "medium" : hasLow ? "low" : null;
      const clean = line.replace(/\[高信心\]|\[需驗證\]|\[建議自行計算\]/g, "").replace(/^##\s*/, "");

      if (isH2) return <h3 key={i} style={{ fontSize: 15, fontWeight: 700, color: "#222", marginTop: 14, marginBottom: 4 }}><RenderWithMath text={clean} /></h3>;

      const bg = isError ? "#FFF0F0" : isWarn ? "#FFF8F0" : isTip ? "#F0FFF4" : "transparent";
      const bl = isError ? "#C62828" : isWarn ? "#E8590C" : isTip ? "#2B8A3E" : "transparent";

      return (
        <div key={i} style={{ fontSize: 13, lineHeight: 1.75, color: "#444", padding: "5px 10px", borderRadius: 6, background: bg, borderLeft: bl !== "transparent" ? `3px solid ${bl}` : "none", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
          <span style={{ flex: 1 }}><RenderWithMath text={clean} /></span>
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
  const Back = ({ to = "home", label = "← 返回" }) => <button onClick={() => { setView(to); if (to === "home") { setImage(null); setImageData(null); setAiResult(null); setFollowUp(null); } }} style={{ background: "none", border: "none", fontSize: 14, color: "#888", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{label}</button>;

  if (view === "home") return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <div style={{ textAlign: "center", padding: "28px 0 20px" }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "#1a1a1a", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700 }}>學</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>學習戰友</h1>
          <p style={{ fontSize: 14, color: "#888", marginTop: 2 }}>拍照 → AI 分析 → 搞懂它</p>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>科目（{Object.keys(SUBJECTS).length}）</span>
          <button onClick={() => setView("subjects")}
            style={{ fontSize: 12, color: "#1971C2", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            管理 →
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {Object.entries(SUBJECTS).map(([key, val]) => (
            <button key={key} onClick={() => { setSubject(key); setView("upload"); }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 12px", border: "1px solid #e8e8e8", borderRadius: 10, cursor: "pointer", background: "#fff", fontFamily: "inherit", fontSize: 14, textAlign: "left", borderLeft: `4px solid ${val.color}` }}>
              <span style={{ fontSize: 24 }}>{val.icon}</span>
              <span style={{ fontWeight: 500 }}>{val.label}</span>
            </button>
          ))}
          <button onClick={() => { openSubjectEditor("new"); setView("subjects"); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "14px 12px", border: "1.5px dashed #ccc", borderRadius: 10, cursor: "pointer", background: "transparent", fontFamily: "inherit", fontSize: 13, color: "#888" }}>
            <span style={{ fontSize: 20 }}>+</span>
            <span>新增科目</span>
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "12px 10px", border: "1px solid #e8e8e8", borderRadius: 10, cursor: "pointer", background: "#fff", fontFamily: "inherit", textAlign: "left" }} onClick={() => setView("stuck")}>
            <span style={{ fontSize: 22 }}>🚧</span>
            <div><div style={{ fontWeight: 500, fontSize: 13 }}>卡關大全</div><div style={{ fontSize: 11, color: "#999" }}>{stuckPoints.length} 個待突破</div></div>
          </button>
          <button style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "12px 10px", border: "1px solid #e8e8e8", borderRadius: 10, cursor: "pointer", background: "#fff", fontFamily: "inherit", textAlign: "left" }} onClick={() => { if (stuckPoints.filter(p => !p.resolved && isDue(p)).length > 0) { setCurrentCard(0); setShowAnswer(false); setView("review"); } }}>
            <span style={{ fontSize: 22 }}>🔄</span>
            <div><div style={{ fontWeight: 500, fontSize: 13 }}>間隔複習</div><div style={{ fontSize: 11, color: "#999" }}>{stuckPoints.filter(p => !p.resolved && isDue(p)).length} 張今日到期</div></div>
          </button>
        </div>
      </P>
    </div>
  );

  if (view === "upload") return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fillBar{from{width:0%}to{width:92%}}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <Back />
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
              style={{ marginTop: 20, padding: "40px 20px", border: `2px dashed ${isDragging ? SUBJECTS[subject]?.color : "#ccc"}`, borderRadius: 14, textAlign: "center", background: isDragging ? `${SUBJECTS[subject]?.color}10` : "#fff", transition: "all 0.2s" }}>
              <span style={{ fontSize: 40, opacity: 0.6 }}>📋</span>
              <p style={{ fontSize: 16, fontWeight: 500, marginTop: 10, color: "#444" }}>拖放圖片到這裡</p>
              <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>或 <strong>Ctrl+V</strong> 貼上截圖</p>
              <p style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>支援 JPG、PNG 格式</p>
            </div>

            <div style={{ textAlign: "center", margin: "18px 0", fontSize: 13, color: "#bbb" }}>— 或 —</div>
            <button
              onClick={() => analyzeImage(true)}
              disabled={loading}
              style={{ width: "100%", padding: "14px", border: `2px solid ${SUBJECTS[subject]?.color}`, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600, background: "#fff", fontFamily: "inherit", color: SUBJECTS[subject]?.color }}>
              {loading ? <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span> 分析中...</span> : "🎮 用範例體驗完整流程"}
            </button>
            <p style={{ fontSize: 12, color: "#aaa", marginTop: 6, textAlign: "center", lineHeight: 1.5 }}>
              使用預設的{SUBJECTS[subject]?.label}筆記，體驗完整的分析→提問→卡關記錄流程
            </p>
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

  if (view === "result") return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <Back />
        <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>{SUBJECTS[subject]?.icon} 分析結果</h2>

        <div style={{ display: "flex", gap: 5, marginTop: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {Object.entries(CONFIDENCE_STYLES).map(([k, v]) => (
            <span key={k} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 500, background: v.bg, color: v.text, border: `1px solid ${v.border}` }}>{v.label}</span>
          ))}
        </div>

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
              {followUp.split("\n").map((l, i) => l.trim() ? <p key={i} style={{ fontSize: 13, lineHeight: 1.7, color: "#333", marginBottom: 3 }}><RenderWithMath text={l} /></p> : null)}
            </div>
          )}
        </div>

        <button onClick={() => { setView("upload"); setImage(null); setImageData(null); setAiResult(null); setFollowUp(null); }}
          style={{ marginTop: 18, width: "100%", padding: "13px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 500, fontFamily: "inherit" }}>
          分析下一張 →
        </button>
      </P>
    </div>
  );

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
        </P>
      </div>
    );
  }

  if (view === "stuck") return (
    <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <P>
        <Back />
        <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>🚧 卡關大全</h2>
        <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 16 }}>所有「不懂」集中在這裡</p>

        {stuckPoints.length === 0 ? (
          <div style={{ textAlign: "center", padding: "44px 20px", color: "#777" }}>
            <span style={{ fontSize: 44 }}>🎯</span>
            <p style={{ marginTop: 10, fontWeight: 500 }}>還沒有卡關紀錄</p>
            <p style={{ fontSize: 13, color: "#999", marginTop: 4 }}>分析筆記後對不懂的地方提問，就會記錄在這</p>
          </div>
        ) : stuckPoints.map((pt) => (
          <div key={pt.id} style={{ background: "#fff", padding: "12px 14px", borderRadius: 8, border: "1px solid #eee", marginBottom: 8, borderLeft: `4px solid ${SUBJECTS[pt.subject]?.color || "#999"}`, opacity: pt.resolved ? 0.5 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#777" }}>{SUBJECTS[pt.subject]?.label}</span>
              <div style={{ display: "flex", gap: 3 }}>
                {[1, 2, 3, 4, 5].map(d => <span key={d} style={{ width: 7, height: 7, borderRadius: "50%", background: d <= pt.difficulty ? SUBJECTS[pt.subject]?.color : "#ddd", display: "inline-block" }} />)}
              </div>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, marginTop: 6, lineHeight: 1.5 }}>{pt.summary}</p>
            {pt.reviewTopic && <p style={{ fontSize: 12, color: "#1971C2", marginTop: 4 }}>📚 {pt.reviewTopic}</p>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#bbb" }}>{pt.timestamp} · {pt.resolved ? "已搞懂" : formatDueLabel(pt)}</span>
              <button onClick={() => setStuckPoints(prev => prev.map(p => p.id === pt.id ? { ...p, resolved: !p.resolved } : p))}
                style={{ padding: "4px 10px", border: "1px solid #ddd", borderRadius: 5, cursor: "pointer", background: "#fff", fontSize: 11, fontFamily: "inherit" }}>
                {pt.resolved ? "↩ 再看看" : "✓ 搞懂了"}
              </button>
            </div>
          </div>
        ))}
      </P>
    </div>
  );

  if (view === "review") {
    const unresolved = stuckPoints
      .filter(p => !p.resolved && isDue(p))
      .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));
    if (unresolved.length === 0) return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <P><Back /><div style={{ textAlign: "center", padding: "44px 20px" }}><span style={{ fontSize: 44 }}>🎉</span><p style={{ marginTop: 10 }}>今日複習完成！</p><p style={{ fontSize: 13, color: "#888", marginTop: 6 }}>下一張卡片會在排程時間到達後出現</p></div></P>
      </div>
    );
    const card = unresolved[currentCard % unresolved.length];

    const handleGrade = (quality) => {
      setStuckPoints(prev => prev.map(p => p.id === card.id ? gradeCard(p, quality) : p));
      setShowAnswer(false);
      setCurrentCard(c => c + 1);
    };

    return (
      <div style={{ fontFamily: "'Noto Sans TC', sans-serif", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "#FAFAF8" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <P>
          <Back />
          <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 12, textAlign: "center" }}>🔄 間隔複習</h2>
          <p style={{ textAlign: "center", fontSize: 13, color: "#888", marginBottom: 20 }}>{currentCard % unresolved.length + 1} / {unresolved.length}</p>

          <div onClick={() => setShowAnswer(!showAnswer)}
            style={{ background: "#fff", padding: "28px 20px", borderRadius: 12, border: "1px solid #e8e8e8", borderTop: `4px solid ${SUBJECTS[card.subject]?.color}`, minHeight: 180, cursor: "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#999" }}>{SUBJECTS[card.subject]?.label}</span>
            <p style={{ fontSize: 16, fontWeight: 500, marginTop: 12, lineHeight: 1.6 }}>{card.question || card.summary}</p>
            {!showAnswer ? (
              <p style={{ marginTop: 20, fontSize: 13, color: "#ccc" }}>👆 點擊看解答</p>
            ) : (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #eee", textAlign: "left", width: "100%" }}>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: "#444" }}>{card.summary}</p>
                {card.reviewTopic && <p style={{ fontSize: 13, color: "#1971C2", marginTop: 6 }}>📚 {card.reviewTopic}</p>}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button onClick={() => handleGrade(0)} style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#C62828" }}>😵 不懂<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>10 分鐘後</div></button>
            <button onClick={() => handleGrade(3)} style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#E8590C" }}>🤔 模糊<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>明天</div></button>
            <button onClick={() => handleGrade(5)} style={{ flex: 1, padding: "13px 6px", border: "none", borderRadius: 8, cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: "#2B8A3E" }}>✅ 懂了<div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>拉長間隔</div></button>
          </div>
        </P>
      </div>
    );
  }

  return null;
}
