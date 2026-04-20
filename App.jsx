import { useState, useEffect, useCallback, useMemo } from "react";
import Tesseract from "tesseract.js";

/* ─── Cookie helpers (survives localStorage clear) ─── */
const cookie = {
  get(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  },
  set(name, value, days = 3650) {
    const d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },
};

/* ─── Storage abstraction ─── */
const store = {
  async get(key) {
    try {
      if (window.storage?.get) {
        const v = await window.storage.get(key);
        return v ? JSON.parse(v) : null;
      }
    } catch {}
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {}
    return null;
  },
  async set(key, value) {
    const json = JSON.stringify(value);
    try {
      if (window.storage?.set) {
        await window.storage.set(key, json);
        return;
      }
    } catch {}
    try {
      localStorage.setItem(key, json);
    } catch {}
  },
  async remove(key) {
    try {
      if (window.storage?.delete) {
        await window.storage.delete(key);
        return;
      }
    } catch {}
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

/* ─── Pet-type configuration ─── */
const DER_FACTOR = { cat: 0.84, dog: 1.4 };
const PET_LABEL = { cat: "猫", dog: "犬" };
const PET_EMOJI = { cat: "🐱", dog: "🐶" };

/* ─── App changelog (newest first) ─── */
const CURRENT_VERSION = "1.6.0";
const CHANGELOG = [
  {
    version: "1.6.0",
    date: "2026-04-20",
    changes: [
      "テンプレート機能を廃止し、日付メニュー履歴に一本化（既存データは自動移行）",
      "日付メニュー履歴にカレンダー表示を追加（Googleカレンダー風）",
      "履歴カードから📝メモをインライン編集できるように",
      "「読み込む」を「表示する」にリネーム＋トースト通知",
      "📊 期間平均カロリー機能を追加（入力のない日は自動除外＋備考表示）",
      "🔔 アプリ更新履歴ボタンを追加",
    ],
  },
  {
    version: "1.5.0",
    date: "2026-04-19",
    changes: [
      "日付メニュー機能＋多頭飼い対応（ペット名autocomplete）",
      "AI自動入力で食材名（ささみ・鶏むね等）の成分表に対応",
      "成分表撮影の「本日残り○回」動的表示",
      "上書き保存時に「上書き保存OK!」アラート表示",
    ],
  },
];

/* ─── Calculation helpers ─── */
const calcDER = (w, petType = "cat") =>
  w > 0 ? 70 * Math.pow(w, 0.75) * (DER_FACTOR[petType] ?? 0.84) : 0;

const calcCarbs = (p, fa, fi, a, m) =>
  Math.max(0, 100 - (p || 0) - (fa || 0) - (fi || 0) - (a || 0) - (m || 0));

const fmt = (n) => (typeof n === "number" && !isNaN(n) ? n.toFixed(1) : "—");

const pct = (n) =>
  typeof n === "number" && !isNaN(n) ? n.toFixed(1) + "%" : "—";

/* ─── Unique ID ─── */
let _seq = 0;
const uid = () => `${Date.now()}-${++_seq}`;

/* ─── Default empty food form ─── */
const EMPTY_FOOD = {
  name: "",
  protein: "",
  fat: "",
  fiber: "",
  ash: "",
  moisture: "",
  kcalGrams: "",
  kcalValue: "",
  isComplete: false,
};

/* ─── One-time migration: convert legacy templates (no date) to dated menus ─── */
function migrateTemplatesToDated(menus) {
  if (!Array.isArray(menus)) return menus;
  const hasLegacyTemplate = menus.some((m) => !m.date);
  if (!hasLegacyTemplate) return menus;
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const converted = menus.map((m) => {
    if (m.date) return m;
    let date = todayStr;
    if (m.savedAt) {
      const sa = new Date(m.savedAt);
      if (!isNaN(sa.getTime())) {
        date = `${sa.getFullYear()}-${String(sa.getMonth() + 1).padStart(2, "0")}-${String(sa.getDate()).padStart(2, "0")}`;
      }
    }
    const parts = [];
    if (m.note && m.note.trim()) parts.push(m.note.trim());
    if (m.name && m.name.trim()) parts.push(m.name.trim());
    const mergedNote = parts.join(" / ");
    const { name, ...rest } = m;
    return { ...rest, date, note: mergedNote };
  });
  const sig = (m) => {
    const items = (m.items || [])
      .map((it) => `${it.id || it.name}:${it.grams || 0}`)
      .sort()
      .join(",");
    return `${m.date}|${(m.petName || "").trim()}|${(m.note || "").trim()}|${items}`;
  };
  const seen = new Set();
  const deduped = [];
  for (const m of converted) {
    const k = sig(m);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(m);
  }
  return deduped;
}

/* ─── CSV export ─── */
function exportCSV(petName, weight, der, waterNeed, items, totals, dm, petType = "cat") {
  const rows = [
    [`${PET_LABEL[petType] || "猫"}の食事管理レポート`],
    [],
    ["ペット名", petName],
    ["体重(kg)", weight],
    ["必要カロリー(kcal)", fmt(der)],
    ["必要水分量(ml)", fmt(waterNeed)],
    [],
    [
      "商品名", "糖質(%)", "タンパク質(%)", "脂質(%)", "粗繊維(%)", "灰分(%)",
      "水分(%)", "kcal/100g", "給餌量(g)", "合計カロリー(kcal)", "水分(ml)", "総合栄養食",
    ],
  ];

  items.forEach((it) => {
    const f = it.food;
    const carb = calcCarbs(f.protein, f.fat, f.fiber, f.ash, f.moisture);
    rows.push([
      f.name, fmt(carb), fmt(f.protein), fmt(f.fat), fmt(f.fiber), fmt(f.ash),
      fmt(f.moisture), fmt(f.kcalPer100g), fmt(it.amount),
      fmt(f.kcalPer100g * it.amount / 100), fmt((it.amount * f.moisture) / 100),
      f.isComplete ? "○" : "",
    ]);
  });

  rows.push(["合計", "", "", "", "", "", "", "", fmt(totals.amount), fmt(totals.kcal), fmt(totals.water)]);
  rows.push([]);
  rows.push(["DM(乾物量ベース)"]);
  rows.push(["糖質", "タンパク質", "脂質", "粗繊維", "灰分"]);
  rows.push([pct(dm.carb), pct(dm.protein), pct(dm.fat), pct(dm.fiber), pct(dm.ash)]);

  const bom = "\uFEFF";
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${petName || "cat"}_食事管理_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════ */
const WORKER_BASE_URL = "https://cat-food-api.catchingdorcus.workers.dev";

/* ═══════════════════════════════════════════
   License Gate (認証画面)
   ═══════════════════════════════════════════ */
function LicenseGate({ onUnlock }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [purchasing, setPurchasing] = useState(false);
  const [postPurchaseMessage, setPostPurchaseMessage] = useState("");

  // 決済成功で戻ってきた場合、URLパラメータからsession_idを取得してコード自動入力
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    const sessionId = params.get("session_id");
    if (checkout === "success" && sessionId) {
      // URLから削除（再読込時に再実行されないように）
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
      // コード取得（Webhook処理が完了するまで最大10秒リトライ）
      setPostPurchaseMessage("決済完了！コードを取得中...");
      setLoading(true);
      (async () => {
        for (let i = 0; i < 10; i++) {
          try {
            const resp = await fetch(`${WORKER_BASE_URL}/get-license-by-session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId }),
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data.code) {
              setCode(data.code);
              setPostPurchaseMessage(`購入ありがとうございます！ライセンスコード: ${data.code}（自動入力されました）`);
              setLoading(false);
              return;
            }
            if (resp.status === 202) {
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            setPostPurchaseMessage("コード取得に失敗しました。メールをご確認ください。");
            setLoading(false);
            return;
          } catch {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        setPostPurchaseMessage("コード取得がタイムアウトしました。メールをご確認ください。");
        setLoading(false);
      })();
    } else if (checkout === "cancel") {
      setPostPurchaseMessage("決済がキャンセルされました。");
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, []);

  const handlePurchase = async () => {
    setPurchasing(true);
    setError("");
    try {
      const resp = await fetch(`${WORKER_BASE_URL}/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.url) {
        setError(data.error || "決済画面の準備に失敗しました");
        setPurchasing(false);
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      setError("通信エラー: " + (err.message || "不明なエラー"));
      setPurchasing(false);
    }
  };

  const handleSubmit = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) { setError("コードを入力してください"); return; }
    setLoading(true);
    setError("");
    try {
      // デバイスID（localStorage に永続化）
      let deviceId = localStorage.getItem("device-id");
      if (!deviceId) {
        deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
        localStorage.setItem("device-id", deviceId);
      }
      const resp = await fetch(`${WORKER_BASE_URL}/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed, deviceId }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        setError(data.reason || `認証エラー (${resp.status})`);
        return;
      }
      const license = {
        code: trimmed,
        type: data.type,
        expiresAt: data.expiresAt || null,
        verifiedAt: new Date().toISOString(),
      };
      localStorage.setItem("license", JSON.stringify(license));
      onUnlock(license);
    } catch (err) {
      setError("通信エラー: " + (err.message || "不明なエラー"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="text-5xl mb-2">🐱</div>
          <h1 className="text-xl font-bold text-amber-800">くぅの食事管理アプリ</h1>
          <p className="text-sm text-gray-600 mt-2">アクセスコードを入力してください</p>
        </div>
        {postPurchaseMessage && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 text-center">
            {postPurchaseMessage}
          </div>
        )}
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="例: CM-XXXXXX"
          className="w-full border-2 border-gray-300 rounded-lg px-4 py-3 text-center text-lg tracking-wider uppercase focus:border-amber-500 focus:outline-none"
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          disabled={loading}
        />
        {error && <p className="text-red-600 text-sm mt-3 text-center">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={loading || !code.trim()}
          className="w-full mt-4 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-lg transition"
        >
          {loading ? "認証中..." : "アプリを開く"}
        </button>

        {/* 買い切り購入ボタン */}
        <div className="mt-6 pt-6 border-t border-gray-200">
          <p className="text-xs text-center text-gray-500 mb-3">コードをお持ちでない方</p>
          <button
            onClick={handlePurchase}
            disabled={purchasing}
            className="w-full bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg transition shadow-md"
          >
            {purchasing ? "決済画面を準備中..." : "💳 買い切り版を購入（¥1,980）"}
          </button>
          <p className="text-[10px] text-gray-400 text-center mt-2">
            Stripe決済／決済完了後にコードが自動入力されます
          </p>
        </div>

        <div className="mt-6 text-xs text-gray-500 space-y-2">
          <p>📺 <strong>YouTubeメンバーシップ会員</strong>の方は、メンバー限定投稿で配布されるコードをご入力ください（月次更新）</p>
          <p>💳 <strong>買い切り版（¥1,980）</strong>をご購入の方は、決済後にメールで届くコードをご入力ください（無期限）</p>
          <p>🔒 買い切り版は1コードあたり3デバイスまで登録可能</p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   App Wrapper (License認証を先に処理)
   ═══════════════════════════════════════════ */
export default function App() {
  const [license, setLicense] = useState(null);
  const [licenseChecked, setLicenseChecked] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem("license");
    if (raw) {
      try {
        const lic = JSON.parse(raw);
        if (lic.expiresAt) {
          const exp = new Date(lic.expiresAt);
          if (new Date() > exp) {
            localStorage.removeItem("license");
            setLicenseChecked(true);
            return;
          }
        }
        setLicense(lic);
      } catch { localStorage.removeItem("license"); }
    }
    setLicenseChecked(true);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("license");
    setLicense(null);
  };

  if (!licenseChecked) return null;
  if (!license) return <LicenseGate onUnlock={setLicense} />;
  return <CatFoodCalculator license={license} onLogout={handleLogout} />;
}

function CatFoodCalculator({ license, onLogout }) {
  /* ─── Pet type (cat / dog) ─── */
  const [petType, setPetType] = useState("cat");

  /* ─── Current editing state ─── */
  const [petName, setPetName] = useState("");
  const [weight, setWeight] = useState("");
  const [foodMaster, setFoodMaster] = useState([]);
  const [menuItems, setMenuItems] = useState([]);

  /* ─── Saved menus (all are dated) ─── */
  const [savedMenus, setSavedMenus] = useState([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveDate, setSaveDate] = useState(""); // YYYY-MM-DD
  const [savePet, setSavePet] = useState(""); // pet name for dated menu
  const [saveMemo, setSaveMemo] = useState(""); // memo for dated menu
  const [loadedMenuId, setLoadedMenuId] = useState(null);
  const [editingMemoId, setEditingMemoId] = useState(null); // id of dated menu whose memo is being edited
  const [editingMemoDraft, setEditingMemoDraft] = useState("");
  const [historyView, setHistoryView] = useState("list"); // "list" | "calendar"
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [statFrom, setStatFrom] = useState("");
  const [statTo, setStatTo] = useState("");
  const [statPet, setStatPet] = useState("__all__");
  const [showChangelog, setShowChangelog] = useState(false);
  const [lastReadVersion, setLastReadVersion] = useState(() => {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem("last-read-version") || "";
  });

  /* ─── Dialogs ─── */
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState("select");
  const [selectedMasterId, setSelectedMasterId] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [newFood, setNewFood] = useState({ ...EMPTY_FOOD });
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [editingFoodId, setEditingFoodId] = useState(null);
  const [editFood, setEditFood] = useState({ ...EMPTY_FOOD });
  const [loaded, setLoaded] = useState(false);

  /* ─── Goal mode (diet / gain) ─── */
  const [goalMode, setGoalMode] = useState(null);

  /* ─── Gemini API ─── */
  const [geminiKey, setGeminiKey] = useState("");
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [scanRemaining, setScanRemaining] = useState(null);
  const [searchRemaining, setSearchRemaining] = useState(null);

  /* ─── Cloud backup ─── */
  const [backupCode, setBackupCode] = useState("");
  const [restoreCode, setRestoreCode] = useState("");
  const [backupStatus, setBackupStatus] = useState("");

  /* ─── Daily notes ─── */
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [dailyNotes, setDailyNotes] = useState({}); // { "YYYY-MM-DD": "本文" }
  const [noteDate, setNoteDate] = useState(todayStr());
  const [noteDraft, setNoteDraft] = useState("");
  const [showNotesHistory, setShowNotesHistory] = useState(false);

  /* ─── Load (with auto-restore from cloud) ─── */
  useEffect(() => {
    (async () => {
      let master = await store.get("food-master") || [];
      const petInfo = await store.get("pet-info");
      const current = await store.get("current-menu");

      // Check if local data exists
      const hasLocalData = master.length > 0 || petInfo || (current && current.items?.length > 0);

      // Get backup code from localStorage or cookie
      let code = await store.get("backup-code");
      if (!code) code = cookie.get("catfood-backup");

      // Auto-restore from cloud if local data is empty but backup code exists
      if (!hasLocalData && code) {
        try {
          const resp = await fetch(`${WORKER_URL}/restore`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          if (resp.ok) {
            const result = await resp.json();
            const d = result.data;
            if (d) {
              if (d.petName) setPetName(d.petName);
              if (d.weight) setWeight(String(d.weight));
              if (d.foodMaster?.length) { master = d.foodMaster; await store.set("food-master", master); }
              if (d.menuItems?.length) setMenuItems(d.menuItems);
              if (d.savedMenus?.length) { setSavedMenus(d.savedMenus); await store.set("saved-menus", d.savedMenus); }
              if (d.dailyNotes && typeof d.dailyNotes === "object") {
                setDailyNotes(d.dailyNotes);
                await store.set("daily-notes", d.dailyNotes);
              }
              await store.set("pet-info", { petName: d.petName || "", weight: d.weight || "" });
              await store.set("backup-code", code);
            }
          }
        } catch {}
      } else {
        // Normal local load
        if (petInfo) {
          setPetName(petInfo.petName || "");
          setWeight(petInfo.weight || "");
        }
        if (current) {
          if (!petInfo && current.petName) setPetName(current.petName);
          if (!petInfo && current.weight) setWeight(String(current.weight));
          setMenuItems(current.items || []);
        }
        const saved = await store.get("saved-menus");
        if (saved) {
          const migrated = migrateTemplatesToDated(saved);
          if (migrated !== saved) {
            await store.set("saved-menus", migrated);
          }
          setSavedMenus(migrated);
        }
      }

      // Ensure water is in master
      const WATER = { id: "__water__", name: "水", protein: 0, fat: 0, fiber: 0, ash: 0, moisture: 100, kcalPer100g: 0, isComplete: false };
      if (!master.find((f) => f.id === "__water__")) master.unshift(WATER);
      setFoodMaster(master);

      const apiKey = await store.get("gemini-api-key");
      if (apiKey) setGeminiKey(apiKey);

      // Auto-generate backup code if none exists
      if (!code) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        code = "";
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        await store.set("backup-code", code);
      }
      setBackupCode(code);
      cookie.set("catfood-backup", code);

      setLoaded(true);
    })();
  }, []);

  /* ─── Load pet type ─── */
  useEffect(() => {
    (async () => {
      const p = await store.get("pet-type");
      if (p === "cat" || p === "dog") setPetType(p);
    })();
  }, []);

  /* ─── Fetch initial AI rate-limit status ─── */
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${WORKER_URL}/rate-status`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.scan?.remaining != null) setScanRemaining(data.scan.remaining);
        if (data?.search?.remaining != null) setSearchRemaining(data.search.remaining);
      } catch {}
    })();
  }, []);

  /* ─── Auto-save pet type ─── */
  useEffect(() => {
    if (!loaded) return;
    store.set("pet-type", petType);
  }, [petType, loaded]);

  /* ─── Load daily notes ─── */
  useEffect(() => {
    (async () => {
      const n = await store.get("daily-notes");
      if (n && typeof n === "object") {
        setDailyNotes(n);
        const today = todayStr();
        if (n[today]) setNoteDraft(n[today]);
      }
    })();
  }, []);

  /* ─── Sync note draft when date selection changes ─── */
  useEffect(() => {
    setNoteDraft(dailyNotes[noteDate] || "");
  }, [noteDate]);

  /* ─── Save note for the selected date ─── */
  const saveNote = useCallback(async () => {
    const trimmed = noteDraft.trim();
    const next = { ...dailyNotes };
    if (trimmed) {
      next[noteDate] = trimmed;
    } else {
      delete next[noteDate];
    }
    setDailyNotes(next);
    await store.set("daily-notes", next);
  }, [noteDraft, noteDate, dailyNotes]);

  /* ─── Delete note for a specific date ─── */
  const deleteNote = useCallback(async (date) => {
    const next = { ...dailyNotes };
    delete next[date];
    setDailyNotes(next);
    await store.set("daily-notes", next);
    if (date === noteDate) setNoteDraft("");
  }, [dailyNotes, noteDate]);

  /* ─── Auto-save pet info separately ─── */
  useEffect(() => {
    if (!loaded) return;
    store.set("pet-info", { petName, weight: weight });
  }, [petName, weight, loaded]);

  /* ─── Auto-save current editing state ─── */
  useEffect(() => {
    if (!loaded) return;
    store.set("current-menu", {
      petName,
      weight: parseFloat(weight) || 0,
      items: menuItems,
    });
  }, [petName, weight, menuItems, loaded]);

  /* ─── Cloud backup (auto-save on data change) ─── */
  useEffect(() => {
    if (!loaded || !backupCode) return;
    const timer = setTimeout(async () => {
      try {
        await fetch(`${WORKER_URL}/backup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: backupCode,
            data: { petName, weight, foodMaster, menuItems, savedMenus, dailyNotes },
          }),
        });
        cookie.set("catfood-backup", backupCode);
      } catch {}
    }, 2000); // 2秒デバウンス
    return () => clearTimeout(timer);
  }, [petName, weight, foodMaster, menuItems, savedMenus, dailyNotes, backupCode, loaded]);

  const restoreFromCloud = useCallback(async (code) => {
    try {
      const resp = await fetch(`${WORKER_URL}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await resp.json();
      if (!resp.ok) { alert(result.error || "復元に失敗しました"); return false; }
      const d = result.data;
      if (d.petName) setPetName(d.petName);
      if (d.weight) setWeight(String(d.weight));
      if (d.foodMaster?.length) { setFoodMaster(d.foodMaster); await store.set("food-master", d.foodMaster); }
      if (d.menuItems?.length) setMenuItems(d.menuItems);
      if (d.savedMenus?.length) { setSavedMenus(d.savedMenus); await store.set("saved-menus", d.savedMenus); }
      if (d.dailyNotes && typeof d.dailyNotes === "object") {
        setDailyNotes(d.dailyNotes);
        await store.set("daily-notes", d.dailyNotes);
      }
      setBackupCode(code);
      await store.set("backup-code", code);
      await store.set("pet-info", { petName: d.petName || "", weight: d.weight || "" });
      alert("データを復元しました！");
      return true;
    } catch (err) {
      alert("復元に失敗しました: " + err.message);
      return false;
    }
  }, []);

  /* ─── Save master ─── */
  const saveMaster = useCallback(async (m) => {
    setFoodMaster(m);
    await store.set("food-master", m);
  }, []);

  /* ─── Pet name candidates for autocomplete (from past menus) ─── */
  const petNameCandidates = useMemo(() => {
    const set = new Set();
    savedMenus.forEach((m) => {
      if (m.petName) set.add(m.petName);
    });
    if (petName) set.add(petName);
    return [...set];
  }, [savedMenus, petName]);

  /* ─── Save as dated menu (with pet+memo) ─── */
  const saveAsDailyMenu = useCallback(async () => {
    if (!saveDate) { alert("日付を選んでください"); return; }
    const pn = (savePet || petName).trim();
    if (!pn) { alert("ペット名を入れてください"); return; }
    // Replace existing same-date+same-pet entry if exists
    const filtered = savedMenus.filter(
      (m) => !(m.date === saveDate && (m.petName || "") === pn)
    );
    const newSaved = {
      id: uid(),
      name: `${pn} ${saveDate}`,
      date: saveDate,
      petName: pn,
      weight: parseFloat(weight) || 0,
      items: [...menuItems],
      note: saveMemo || "",
      savedAt: new Date().toISOString(),
    };
    const updated = [...filtered, newSaved];
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
    setSaveDate("");
    setSavePet("");
    setSaveMemo("");
    setShowSaveForm(false);
    alert("日付メニューとして保存しました");
  }, [saveDate, savePet, petName, weight, menuItems, saveMemo, savedMenus]);

  /* ─── Save (called from form) ─── */
  const saveCurrentMenu = saveAsDailyMenu;

  /* ─── Load a saved menu ─── */
  const loadMenu = useCallback((menu) => {
    setPetName(menu.petName || "");
    setWeight(menu.weight ? String(menu.weight) : "");
    setMenuItems(menu.items || []);
    setLoadedMenuId(menu.id);
    setShowAdd(false);
    alert("表示しました");
  }, []);

  /* ─── Overwrite a saved menu ─── */
  const overwriteMenu = useCallback(async () => {
    if (!loadedMenuId) return;
    const updated = savedMenus.map((m) =>
      m.id === loadedMenuId
        ? { ...m, petName, weight: parseFloat(weight) || 0, items: [...menuItems], savedAt: new Date().toISOString() }
        : m
    );
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
    alert("上書き保存OK!");
  }, [loadedMenuId, savedMenus, petName, weight, menuItems]);

  /* ─── Delete a saved menu ─── */
  const deleteSavedMenu = useCallback(async (menuId) => {
    const updated = savedMenus.filter((m) => m.id !== menuId);
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
  }, [savedMenus]);

  /* ─── Update memo on a saved dated menu ─── */
  const updateMenuNote = useCallback(async (menuId, note) => {
    const updated = savedMenus.map((m) =>
      m.id === menuId ? { ...m, note: note.trim() } : m
    );
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
  }, [savedMenus]);

  /* ─── Reset all data (pet info is preserved) ─── */
  const resetAllData = useCallback(async () => {
    await store.remove("current-menu");
    await store.remove("food-master");
    await store.remove("saved-menus");
    // Also clean up old format keys
    await store.remove("menus-list");
    await store.remove("active-menu-id");
    // Note: pet-info is intentionally NOT removed

    setMenuItems([]);
    setFoodMaster([]);
    setSavedMenus([]);
    setShowResetConfirm(false);
  }, []);

  /* ─── Derived ─── */
  const w = parseFloat(weight) || 0;
  const der = calcDER(w, petType);
  const waterNeed = der;

  const enriched = menuItems.map((it) => {
    const f = it.food;
    const carb = calcCarbs(f.protein, f.fat, f.fiber, f.ash, f.moisture);
    const amt = it.amount || 0;
    return {
      ...it, carb,
      totalKcal: f.kcalPer100g * amt / 100,
      waterMl: (amt * f.moisture) / 100,
      gProtein: (amt * f.protein) / 100,
      gFat: (amt * f.fat) / 100,
      gFiber: (amt * f.fiber) / 100,
      gAsh: (amt * f.ash) / 100,
      gMoisture: (amt * f.moisture) / 100,
      gCarb: (amt * carb) / 100,
    };
  });

  const totals = enriched.reduce(
    (acc, e) => ({
      amount: acc.amount + (e.amount || 0),
      kcal: acc.kcal + e.totalKcal,
      water: acc.water + e.waterMl,
      protein: acc.protein + e.gProtein,
      fat: acc.fat + e.gFat,
      fiber: acc.fiber + e.gFiber,
      ash: acc.ash + e.gAsh,
      moisture: acc.moisture + e.gMoisture,
      carb: acc.carb + e.gCarb,
    }),
    { amount: 0, kcal: 0, water: 0, protein: 0, fat: 0, fiber: 0, ash: 0, moisture: 0, carb: 0 }
  );

  const dryTotal = totals.carb + totals.protein + totals.fat + totals.fiber + totals.ash;
  const dm =
    dryTotal > 0
      ? {
          carb: (totals.carb / dryTotal) * 100,
          protein: (totals.protein / dryTotal) * 100,
          fat: (totals.fat / dryTotal) * 100,
          fiber: (totals.fiber / dryTotal) * 100,
          ash: (totals.ash / dryTotal) * 100,
        }
      : { carb: 0, protein: 0, fat: 0, fiber: 0, ash: 0 };

  const kcalDiff = totals.kcal - der;
  const waterDiff = totals.water - waterNeed;
  const kcalPctOfDer = der > 0 ? (totals.kcal / der) * 100 : 0;
  const kcalDiffPct = der > 0 ? ((totals.kcal - der) / der) * 100 : 0;

  const completeKcal = enriched.filter((e) => e.food.isComplete).reduce((s, e) => s + e.totalKcal, 0);
  const generalKcal = totals.kcal - completeKcal;
  const completePct = totals.kcal > 0 ? (completeKcal / totals.kcal) * 100 : 0;
  const generalPct = totals.kcal > 0 ? (generalKcal / totals.kcal) * 100 : 0;

  /* ─── Handlers ─── */
  const addFromMaster = () => {
    const master = foodMaster.find((f) => f.id === selectedMasterId);
    if (!master || !addAmount) return;
    setMenuItems((prev) => [
      ...prev,
      { id: uid(), food: { ...master }, amount: parseFloat(addAmount) || 0 },
    ]);
    setShowAdd(false);
    setSelectedMasterId("");
    setAddAmount("");
  };

  const addNewFood = () => {
    const f = {
      id: uid(), name: newFood.name,
      protein: parseFloat(newFood.protein) || 0,
      fat: parseFloat(newFood.fat) || 0,
      fiber: parseFloat(newFood.fiber) || 0,
      ash: parseFloat(newFood.ash) || 0,
      moisture: parseFloat(newFood.moisture) || 0,
      kcalPer100g: (parseFloat(newFood.kcalGrams) > 0 && parseFloat(newFood.kcalValue) >= 0)
        ? (parseFloat(newFood.kcalValue) / parseFloat(newFood.kcalGrams)) * 100
        : 0,
      isComplete: newFood.isComplete,
    };
    if (!f.name) return;
    saveMaster([...foodMaster, f]);
    setMenuItems((prev) => [
      ...prev,
      { id: uid(), food: { ...f }, amount: parseFloat(addAmount) || 0 },
    ]);
    setShowAdd(false);
    setNewFood({ ...EMPTY_FOOD });
    setAddAmount("");
  };

  const removeItem = (id) => setMenuItems((prev) => prev.filter((it) => it.id !== id));

  const updateAmount = (id, val) =>
    setMenuItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, amount: parseFloat(val) || 0 } : it))
    );

  const removeMasterFood = (id) => {
    saveMaster(foodMaster.filter((f) => f.id !== id));
  };

  const startEditFood = (f) => {
    setEditingFoodId(f.id);
    setEditFood({
      name: f.name, protein: String(f.protein || ""), fat: String(f.fat || ""),
      fiber: String(f.fiber || ""), ash: String(f.ash || ""), moisture: String(f.moisture || ""),
      kcalGrams: "", kcalValue: "", kcalPer100g: f.kcalPer100g || 0, isComplete: !!f.isComplete,
    });
  };

  const saveEditFood = () => {
    const newData = {
      name: editFood.name,
      protein: parseFloat(editFood.protein) || 0, fat: parseFloat(editFood.fat) || 0,
      fiber: parseFloat(editFood.fiber) || 0, ash: parseFloat(editFood.ash) || 0,
      moisture: parseFloat(editFood.moisture) || 0, isComplete: editFood.isComplete,
      kcalPer100g: (parseFloat(editFood.kcalGrams) > 0 && parseFloat(editFood.kcalValue) >= 0)
        ? (parseFloat(editFood.kcalValue) / parseFloat(editFood.kcalGrams)) * 100
        : editFood.kcalPer100g,
    };
    saveMaster(foodMaster.map((f) => f.id === editingFoodId ? { ...f, ...newData } : f));
    setMenuItems((prev) => prev.map((it) => it.food.id === editingFoodId ? { ...it, food: { ...it.food, ...newData } } : it));
    setEditingFoodId(null);
  };

  /* ─── CSV Import ─── */
  const importCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { alert("CSVにデータ行がありません"); return; }

      // Find header row (auto-detect: look for a line containing "商品名")
      let headerIdx = lines.findIndex((l) => /商品名|name/i.test(l));
      if (headerIdx < 0) { alert("「商品名」列が見つかりません"); return; }

      const header = lines[headerIdx].split(",").map((h) => h.trim());
      const nameIdx = header.findIndex((h) => /商品名|name/i.test(h));
      const proteinIdx = header.findIndex((h) => /タンパク|protein/i.test(h));
      const fatIdx = header.findIndex((h) => /脂質|fat/i.test(h));
      const fiberIdx = header.findIndex((h) => /繊維|fiber/i.test(h));
      const ashIdx = header.findIndex((h) => /灰分|ash/i.test(h));
      const moistureIdx = header.findIndex((h) => /水分|moisture/i.test(h));
      const kcalIdx = header.findIndex((h) => /kcal.*100|カロリー/i.test(h));
      const completeIdx = header.findIndex((h) => /総合栄養食|complete/i.test(h));
      const amountIdx = header.findIndex((h) => /給餌量|amount/i.test(h));

      let imported = 0, skipped = 0;
      const existingNames = new Set(foodMaster.map((f) => f.name));
      const newMasterItems = [];
      const newMenuItems = [];

      const SKIP_NAMES = /^(合計|DM|糖質|タンパク質|脂質|粗繊維|灰分|水分|[\d.]+%?)$/;
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim());
        const name = cols[nameIdx];
        if (!name || name === "合計") break;
        if (SKIP_NAMES.test(name)) continue;

        const foodData = {
          id: uid(),
          name,
          protein: parseFloat(cols[proteinIdx]) || 0,
          fat: parseFloat(cols[fatIdx]) || 0,
          fiber: parseFloat(cols[fiberIdx]) || 0,
          ash: parseFloat(cols[ashIdx]) || 0,
          moisture: parseFloat(cols[moistureIdx]) || 0,
          kcalPer100g: parseFloat(cols[kcalIdx]) || 0,
          isComplete: completeIdx >= 0 ? /true|1|○|はい|yes/i.test(cols[completeIdx]) : false,
        };

        // Add to master if not already registered
        if (!existingNames.has(name)) {
          newMasterItems.push(foodData);
          existingNames.add(name);
        }

        // Add to menu with feeding amount
        const amount = amountIdx >= 0 ? parseFloat(cols[amountIdx]) || 0 : 0;
        if (amount > 0) {
          const masterFood = existingNames.has(name)
            ? [...foodMaster, ...newMasterItems].find((f) => f.name === name) || foodData
            : foodData;
          newMenuItems.push({ id: uid(), food: { ...masterFood }, amount });
        }

        imported++;
      }

      if (newMasterItems.length > 0) saveMaster([...foodMaster, ...newMasterItems]);
      if (newMenuItems.length > 0) {
        setMenuItems(newMenuItems);
        // Also save as a preset menu
        const csvName = file.name.replace(/\.csv$/i, "").replace(/^.*_/, "") || "インポート";
        const newSaved = {
          id: uid(),
          name: csvName,
          petName,
          weight: parseFloat(weight) || 0,
          items: [...newMenuItems],
          savedAt: new Date().toISOString(),
        };
        const updatedMenus = [...savedMenus, newSaved];
        setSavedMenus(updatedMenus);
        store.set("saved-menus", updatedMenus);
        setLoadedMenuId(newSaved.id);
      }

      const menuMsg = newMenuItems.length > 0 ? `、保存済みメニューに登録しました` : "";
      alert(`${imported}件インポート${skipped > 0 ? `、${skipped}件スキップ（重複）` : ""}${menuMsg}`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  /* ─── Save Gemini API key ─── */
  const saveApiKey = useCallback(async (key) => {
    setGeminiKey(key);
    await store.set("gemini-api-key", key);
  }, []);

  /* ─── AI auto-fill from product name ─── */
  const WORKER_URL = "https://cat-food-api.catchingdorcus.workers.dev";

  const aiAutoFillViaWorker = async (name) => {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || `エラー (${resp.status})`);
    return result;
  };

  const aiAutoFillDirect = async (name) => {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `あなたはキャットフードの成分データベースです。
以下の商品名のキャットフードの保証分析値（成分表）を教えてください。

商品名: ${name}

以下のJSON形式のみ出力してください。数値が不明な項目は null にしてください。
{
  "name": "正式な商品名",
  "protein": タンパク質の%数値,
  "fat": 脂質の%数値,
  "fiber": 粗繊維の%数値,
  "ash": 灰分の%数値,
  "moisture": 水分の%数値,
  "kcalGrams": カロリー表記の何gの部分(数値),
  "kcalValue": カロリー表記の何kcalの部分(数値),
  "isComplete": 総合栄養食ならtrue、一般食・おやつならfalse
}
JSONのみ出力してください。`
            }],
          }],
          generationConfig: { temperature: 0.1 },
        }),
      }
    );
    if (!resp.ok) throw new Error(`Gemini API エラー (${resp.status})`);
    const data = await resp.json();
    if (data?.error) throw new Error(`Gemini API: ${data.error.message}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return { data: JSON.parse(jsonMatch[0]) };
  };

  const aiAutoFill = async () => {
    const name = newFood.name.trim();
    if (!name) { alert("商品名を入力してください"); return; }
    setAiSearching(true);
    try {
      let result;
      if (geminiKey) {
        result = await aiAutoFillDirect(name);
      } else {
        result = await aiAutoFillViaWorker(name);
      }
      if (!result?.data) { alert("成分情報を取得できませんでした。商品名を正確に入力してみてください。"); return; }
      const parsed = result.data;
      setNewFood((p) => ({
        ...p,
        name: parsed.name || p.name,
        protein: parsed.protein != null ? String(parsed.protein) : p.protein,
        fat: parsed.fat != null ? String(parsed.fat) : p.fat,
        fiber: parsed.fiber != null ? String(parsed.fiber) : p.fiber,
        ash: parsed.ash != null ? String(parsed.ash) : p.ash,
        moisture: parsed.moisture != null ? String(parsed.moisture) : p.moisture,
        kcalGrams: parsed.kcalGrams != null ? String(parsed.kcalGrams) : p.kcalGrams,
        kcalValue: parsed.kcalValue != null ? String(parsed.kcalValue) : p.kcalValue,
        isComplete: parsed.isComplete ?? p.isComplete,
      }));
      if (result.remaining != null) setSearchRemaining(result.remaining);
      const msg = result.remaining != null
        ? `成分情報を取得しました！（本日残り${result.remaining}回）\n内容を確認してください。`
        : "成分情報を取得しました！内容を確認してください。";
      alert(msg);
    } catch (err) {
      alert("成分情報の取得に失敗しました: " + err.message);
    } finally {
      setAiSearching(false);
    }
  };

  /* ─── Scan food label image (Gemini Vision: 自分のAPIキー優先、なければWorkers経由) ─── */
  const WORKER_URL_SCAN = "https://cat-food-api.catchingdorcus.workers.dev";

  const fileToBase64 = (file) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.readAsDataURL(file);
  });

  const scanWithGeminiDirect = async (file) => {
    const base64 = await fileToBase64(file);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `この画像はキャットフードの成分表です。以下のJSON形式で数値を抽出してください。
数値が見つからない項目は0にしてください。商品名も読み取れれば入れてください。
カロリーは「○○gあたり○○kcal」の形で読み取り、kcalGramsとkcalValueに入れてください。
{
  "name": "商品名",
  "protein": タンパク質の数値,
  "fat": 脂質の数値,
  "fiber": 粗繊維の数値,
  "ash": 灰分の数値,
  "moisture": 水分の数値,
  "kcalGrams": カロリー表記の何gの部分,
  "kcalValue": カロリー表記の何kcalの部分
}
JSONのみ出力してください。` },
              { inlineData: { mimeType: file.type, data: base64 } },
            ],
          }],
        }),
      }
    );
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini API エラー (${resp.status}): ${errBody.slice(0, 200)}`);
    }
    const data = await resp.json();
    if (data?.error) throw new Error(`Gemini API: ${data.error.message || JSON.stringify(data.error)}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  };

  const scanWithWorker = async (file) => {
    const base64 = await fileToBase64(file);
    const resp = await fetch(`${WORKER_URL_SCAN}/scan-label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mimeType: file.type || "image/jpeg" }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.error || `サーバーエラー (${resp.status})`);
    }
    return { data: data?.data || null, remaining: data?.remaining };
  };

  const scanWithTesseract = async (file) => {
    const { data: { text } } = await Tesseract.recognize(file, "jpn", {
      logger: () => {},
    });
    // Parse Japanese nutrition label text
    const num = (pattern) => {
      const m = text.match(pattern);
      return m ? parseFloat(m[1]) : 0;
    };
    const protein = num(/(?:たんぱく質|タンパク質|蛋白質|protein)[^\d]*?([\d.]+)/i);
    const fat = num(/(?:脂質|脂肪|fat)[^\d]*?([\d.]+)/i);
    const fiber = num(/(?:粗繊維|繊維|fiber)[^\d]*?([\d.]+)/i);
    const ash = num(/(?:灰分|ash)[^\d]*?([\d.]+)/i);
    const moisture = num(/(?:水分|moisture)[^\d]*?([\d.]+)/i);
    const kcalMatch = text.match(/([\d.]+)\s*(?:g|ｇ)\s*(?:あたり|当たり|当り|につき)?\s*[^\d]*?([\d.]+)\s*(?:kcal|キロカロリー)/i)
      || text.match(/([\d.]+)\s*(?:kcal|キロカロリー)\s*[/／]\s*([\d.]+)\s*(?:g|ｇ)/i);
    let kcalGrams = 0, kcalValue = 0;
    if (kcalMatch) { kcalGrams = parseFloat(kcalMatch[1]); kcalValue = parseFloat(kcalMatch[2]); }
    // Also try "XXXkcal/100g" pattern
    const kcalPer100 = text.match(/([\d.]+)\s*(?:kcal|キロカロリー)\s*[/／]?\s*100\s*(?:g|ｇ)/i);
    if (kcalPer100 && !kcalMatch) { kcalGrams = 100; kcalValue = parseFloat(kcalPer100[1]); }

    if (!protein && !fat && !fiber && !ash && !moisture && !kcalValue) return null;
    return { name: "", protein, fat, fiber, ash, moisture, kcalGrams, kcalValue };
  };

  const scanFoodLabel = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);
    try {
      let parsed = null;
      let remaining = null;
      if (geminiKey) {
        // 飼い主さんが自分のAPIキーを登録済み → 直接Gemini（無制限）
        parsed = await scanWithGeminiDirect(file);
      } else {
        // 未登録 → Workers経由（先生のAPIキー、1日5回制限）
        const result = await scanWithWorker(file);
        parsed = result.data;
        remaining = result.remaining;
      }
      if (parsed) {
        setNewFood((p) => ({
          ...p,
          name: parsed.name || p.name,
          protein: String(parsed.protein ?? ""),
          fat: String(parsed.fat ?? ""),
          fiber: String(parsed.fiber ?? ""),
          ash: String(parsed.ash ?? ""),
          moisture: String(parsed.moisture ?? ""),
          kcalGrams: String(parsed.kcalGrams ?? ""),
          kcalValue: String(parsed.kcalValue ?? ""),
        }));
        if (remaining != null) setScanRemaining(remaining);
        const msg = remaining != null
          ? `成分表を読み取りました！（本日残り${remaining}回）\n内容を確認してください。`
          : "成分表を読み取りました！内容を確認してください。";
        alert(msg);
      } else {
        alert("成分表を読み取れませんでした。手動で入力してください。");
      }
    } catch (err) {
      alert("エラー: " + (err.message || "画像の解析に失敗しました"));
    } finally {
      setScanning(false);
      e.target.value = "";
    }
  };

  /* ─── Status color helpers ─── */
  const kcalStatus =
    menuItems.length === 0 ? "text-gray-400"
      : Math.abs(kcalDiff) <= der * 0.05 ? "text-emerald-600"
      : kcalDiff < 0 ? "text-amber-600" : "text-red-500";

  const waterStatus =
    menuItems.length === 0 ? "text-gray-400"
      : waterDiff >= 0 ? "text-emerald-600" : "text-amber-600";

  /* ═══════════════════════════════════════════
     Render
     ═══════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-amber-50/60 text-gray-800 font-sans">
      {/* Header */}
      <header className="bg-gradient-to-r from-amber-600 to-orange-500 text-white px-4 py-3 shadow-md">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <span className="text-3xl">{PET_EMOJI[petType]}</span>
          <div className="flex-1">
            <h1 className="text-lg font-bold leading-tight">
              {petType === "dog" ? "くぅのドッグフード研究室" : "くぅのキャットフード研究室"}
            </h1>
            <p className="text-amber-100 text-xs">{PET_LABEL[petType]}の食事管理アプリ</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowChangelog(true);
              if (lastReadVersion !== CURRENT_VERSION) {
                setLastReadVersion(CURRENT_VERSION);
                localStorage.setItem("last-read-version", CURRENT_VERSION);
              }
            }}
            className="relative p-1.5 rounded-full hover:bg-white/20 transition"
            aria-label="更新履歴"
          >
            <span className="text-xl">🔔</span>
            {lastReadVersion !== CURRENT_VERSION && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-red-500 rounded-full border border-white" />
            )}
          </button>
          <div className="flex bg-white/20 rounded-full p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setPetType("cat")}
              className={`px-3 py-1 rounded-full transition ${
                petType === "cat" ? "bg-white text-amber-700 font-bold" : "text-white"
              }`}
            >
              🐱 猫
            </button>
            <button
              type="button"
              onClick={() => setPetType("dog")}
              className={`px-3 py-1 rounded-full transition ${
                petType === "dog" ? "bg-white text-amber-700 font-bold" : "text-white"
              }`}
            >
              🐶 犬
            </button>
          </div>
        </div>
      </header>

      {showChangelog && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowChangelog(false)}
        >
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg text-amber-700 flex items-center gap-1.5">
                  <span>🔔</span> 更新履歴
                </h3>
                <button
                  onClick={() => setShowChangelog(false)}
                  className="text-gray-400 hover:text-gray-600 text-xl"
                  aria-label="閉じる"
                >×</button>
              </div>
              <div className="space-y-4">
                {CHANGELOG.map((entry) => (
                  <div key={entry.version} className="space-y-2">
                    <div className="flex items-baseline gap-2 border-b border-amber-200 pb-1">
                      <span className="font-bold text-amber-700">v{entry.version}</span>
                      <span className="text-xs text-gray-400">{entry.date}</span>
                    </div>
                    <ul className="space-y-1 text-sm text-gray-700">
                      {entry.changes.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-amber-400 shrink-0">•</span>
                          <span className="leading-relaxed">{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-4xl mx-auto p-4 space-y-5">
        {/* ── Pet Info ── */}
        <section className="bg-white rounded-xl shadow p-4 space-y-3">
          <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
            <span>🐾</span> ペット情報
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-500">名前</span>
              <input
                className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                placeholder="例: みかん"
                value={petName}
                onChange={(e) => setPetName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">体重 (kg)</span>
              <input
                type="number" step="0.01" min="0"
                className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                placeholder="例: 4.75"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </label>
          </div>
          {w > 0 && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="bg-amber-50 rounded-lg p-3 text-center">
                <p className="text-[11px] text-gray-500">必要カロリー</p>
                <p className="text-xl font-bold text-amber-700">{fmt(der)} <span className="text-sm font-normal">kcal</span></p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <p className="text-[11px] text-gray-500">必要水分量</p>
                <p className="text-xl font-bold text-blue-600">{fmt(waterNeed)} <span className="text-sm font-normal">ml</span></p>
              </div>
            </div>
          )}
        </section>

        {/* ── Food Table ── */}
        <section className="bg-white rounded-xl shadow p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
              <span>🍽️</span> 食事メニュー
            </h2>
            <button
              onClick={() => { setShowAdd(true); setAddMode(foodMaster.length > 0 ? "select" : "new"); }}
              className="bg-amber-600 hover:bg-amber-700 text-white text-sm px-4 py-1.5 rounded-lg transition"
            >+ 商品を追加</button>
          </div>

          {menuItems.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-6">まだ商品が追加されていません</p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-sm border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-amber-50 text-gray-600">
                    <th className="text-left px-2 py-1.5 rounded-tl-lg">商品名</th>
                    <th className="px-1 py-1.5">糖質%</th>
                    <th className="px-1 py-1.5">タンパク%</th>
                    <th className="px-1 py-1.5">脂質%</th>
                    <th className="px-1 py-1.5">繊維%</th>
                    <th className="px-1 py-1.5">灰分%</th>
                    <th className="px-1 py-1.5">水分%</th>
                    <th className="px-1 py-1.5">kcal/100g</th>
                    <th className="px-1 py-1.5">給餌量g</th>
                    <th className="px-1 py-1.5">kcal</th>
                    <th className="px-1 py-1.5">水分ml</th>
                    <th className="px-1 py-1.5 rounded-tr-lg"></th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((e) => (
                    <tr key={e.id} className="border-b border-gray-100 hover:bg-amber-50/40">
                      <td className="px-2 py-1.5 font-medium max-w-[180px]">
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => startEditFood(e.food)}
                            className="bg-amber-100 hover:bg-amber-200 text-amber-700 text-[10px] px-1.5 py-0.5 rounded transition shrink-0"
                            title="編集">編集</button>
                          <span className="truncate">{e.food.name}</span>
                        </div>
                        <div className="mt-0.5 ml-9">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${e.food.isComplete ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                            {e.food.isComplete ? "総合" : "一般"}
                          </span>
                        </div>
                      </td>
                      <td className="text-center px-1 text-gray-500">{fmt(e.carb)}</td>
                      <td className="text-center px-1">{fmt(e.food.protein)}</td>
                      <td className="text-center px-1">{fmt(e.food.fat)}</td>
                      <td className="text-center px-1">{fmt(e.food.fiber)}</td>
                      <td className="text-center px-1">{fmt(e.food.ash)}</td>
                      <td className="text-center px-1">{fmt(e.food.moisture)}</td>
                      <td className="text-center px-1">{fmt(e.food.kcalPer100g)}</td>
                      <td className="text-center px-1">
                        <input type="number" min="0" step="1"
                          className="w-16 border border-gray-200 rounded px-1.5 py-0.5 text-center focus:ring-1 focus:ring-amber-400 focus:outline-none"
                          value={e.amount || ""}
                          onChange={(ev) => updateAmount(e.id, ev.target.value)}
                        />
                      </td>
                      <td className="text-center px-1 font-medium">{fmt(e.totalKcal)}</td>
                      <td className="text-center px-1">{fmt(e.waterMl)}</td>
                      <td className="text-center px-1">
                        <button onClick={() => removeItem(e.id)} className="text-red-400 hover:text-red-600 text-lg leading-none" title="削除">×</button>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-amber-100/60 font-bold">
                    <td className="px-2 py-2">合計</td>
                    <td className="text-center px-1">{fmt(totals.carb)}g</td>
                    <td className="text-center px-1">{fmt(totals.protein)}g</td>
                    <td className="text-center px-1">{fmt(totals.fat)}g</td>
                    <td className="text-center px-1">{fmt(totals.fiber)}g</td>
                    <td className="text-center px-1">{fmt(totals.ash)}g</td>
                    <td className="text-center px-1">{fmt(totals.moisture)}g</td>
                    <td className="text-center px-1"></td>
                    <td className="text-center px-1">{fmt(totals.amount)}g</td>
                    <td className="text-center px-1">{fmt(totals.kcal)}</td>
                    <td className="text-center px-1">{fmt(totals.water)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Inline edit form for food in menu */}
          {editingFoodId && menuItems.some((it) => it.food.id === editingFoodId) && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 space-y-2">
              <p className="text-xs font-bold text-amber-700">商品を編集中</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block col-span-2">
                  <span className="text-[11px] text-gray-500">商品名</span>
                  <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-amber-400 focus:outline-none"
                    value={editFood.name} onChange={(e) => setEditFood((p) => ({ ...p, name: e.target.value }))} />
                </label>
                <label className="flex items-center gap-2 col-span-2 cursor-pointer">
                  <input type="checkbox" checked={editFood.isComplete}
                    onChange={(e) => setEditFood((p) => ({ ...p, isComplete: e.target.checked }))}
                    className="w-3.5 h-3.5 accent-amber-600" />
                  <span className="text-xs text-gray-600">総合栄養食</span>
                </label>
                {[
                  { key: "protein", label: "タンパク%" }, { key: "fat", label: "脂質%" },
                  { key: "fiber", label: "繊維%" }, { key: "ash", label: "灰分%" },
                  { key: "moisture", label: "水分%" },
                ].map(({ key, label }) => (
                  <label key={key} className="block">
                    <span className="text-[11px] text-gray-400">{label}</span>
                    <input type="number" step="0.1" min="0" max="100"
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                      value={editFood[key]} onChange={(e) => setEditFood((p) => ({ ...p, [key]: e.target.value }))} />
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span>現在: {fmt(editFood.kcalPer100g)} kcal/100g</span>
                <span className="mx-1">→</span>
                <input type="number" step="1" min="0" placeholder="g"
                  className="w-14 border border-gray-300 rounded px-1 py-0.5 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                  value={editFood.kcalGrams} onChange={(e) => setEditFood((p) => ({ ...p, kcalGrams: e.target.value }))} />
                <span>gで</span>
                <input type="number" step="0.1" min="0" placeholder="kcal"
                  className="w-14 border border-gray-300 rounded px-1 py-0.5 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                  value={editFood.kcalValue} onChange={(e) => setEditFood((p) => ({ ...p, kcalValue: e.target.value }))} />
                <span>kcal</span>
              </div>
              <div className="flex gap-2">
                <button onClick={saveEditFood}
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-xs py-1.5 rounded transition">保存</button>
                <button onClick={() => setEditingFoodId(null)}
                  className="flex-1 border border-gray-300 text-xs py-1.5 rounded hover:bg-gray-100 transition">キャンセル</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Summary ── */}
        {w > 0 && menuItems.length > 0 && (
          <section className="bg-white rounded-xl shadow p-4 space-y-3">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5"><span>📊</span> サマリー</h2>

            {/* ── Goal buttons ── */}
            <div className="flex gap-2">
              <button
                onClick={() => setGoalMode(goalMode === "diet" ? null : "diet")}
                className={`flex-1 text-xs py-2 rounded-lg border transition font-semibold ${
                  goalMode === "diet"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-blue-600 border-blue-300 hover:bg-blue-50"
                }`}
              >🏃 ダイエット希望</button>
              <button
                onClick={() => setGoalMode(goalMode === "gain" ? null : "gain")}
                className={`flex-1 text-xs py-2 rounded-lg border transition font-semibold ${
                  goalMode === "gain"
                    ? "bg-rose-600 text-white border-rose-600"
                    : "bg-white text-rose-600 border-rose-300 hover:bg-rose-50"
                }`}
              >💪 体重UP希望</button>
            </div>

            {/* ── Goal calorie display ── */}
            {goalMode && totals.kcal > 0 && (
              <div className={`rounded-lg p-3 text-center space-y-1 ${
                goalMode === "diet" ? "bg-blue-50 border border-blue-200" : "bg-rose-50 border border-rose-200"
              }`}>
                <p className="text-xs text-gray-600">
                  {goalMode === "diet" ? "🎯 ダイエット目標（現在の-15%）" : "🎯 体重UP目標（現在の+15%）"}
                </p>
                <p className={`text-2xl font-bold ${goalMode === "diet" ? "text-blue-700" : "text-rose-700"}`}>
                  {fmt(goalMode === "diet" ? totals.kcal * 0.85 : totals.kcal * 1.15)} kcal
                </p>
                <p className="text-xs text-gray-500">
                  現在 {fmt(totals.kcal)} kcal → {goalMode === "diet" ? "-" : "+"}{fmt(totals.kcal * 0.15)} kcal
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3 space-y-1">
                <p className="text-xs text-gray-500">カロリー</p>
                <p className="text-lg font-bold">{fmt(totals.kcal)} <span className="text-sm font-normal text-gray-400">/ {fmt(der)} kcal</span></p>
                <p className={`text-sm font-semibold ${kcalStatus}`}>
                  {kcalDiff >= 0 ? `+${fmt(kcalDiff)} kcal (超過)` : `${fmt(kcalDiff)} kcal (不足)`}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  必要カロリーの {fmt(kcalPctOfDer)}%（{kcalDiffPct >= 0 ? "+" : ""}{fmt(kcalDiffPct)}%）
                </p>
                <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                  <div className={`h-2 rounded-full transition-all ${
                    Math.abs(kcalDiff) <= der * 0.05 ? "bg-emerald-500" : kcalDiff < 0 ? "bg-amber-400" : "bg-red-400"
                  }`} style={{ width: `${Math.min((totals.kcal / der) * 100, 100)}%` }} />
                </div>
              </div>
              <div className="rounded-lg border p-3 space-y-1">
                <p className="text-xs text-gray-500">水分</p>
                <p className="text-lg font-bold">{fmt(totals.water)} <span className="text-sm font-normal text-gray-400">/ {fmt(waterNeed)} ml</span></p>
                <p className={`text-sm font-semibold ${waterStatus}`}>
                  {waterDiff >= 0 ? `十分 (+${fmt(waterDiff)} ml)` : `あと ${fmt(Math.abs(waterDiff))} ml 必要`}
                </p>
                <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                  <div className={`h-2 rounded-full transition-all ${waterDiff >= 0 ? "bg-emerald-500" : "bg-amber-400"}`}
                    style={{ width: `${Math.min((totals.water / waterNeed) * 100, 100)}%` }} />
                </div>
              </div>
            </div>

            {/* ── Food type calorie ratio ── */}
            {totals.kcal > 0 && (
              <div className="rounded-lg border p-3 space-y-2">
                <p className="text-xs text-gray-500">カロリー内訳（総合栄養食 / 一般食）</p>
                <div className="flex gap-3 text-sm">
                  <span className="text-emerald-700 font-semibold">総合: {fmt(completeKcal)} kcal ({fmt(completePct)}%)</span>
                  <span className="text-orange-600 font-semibold">一般: {fmt(generalKcal)} kcal ({fmt(generalPct)}%)</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 flex overflow-hidden">
                  <div className="bg-emerald-500 h-3 transition-all" style={{ width: `${completePct}%` }} />
                  <div className="bg-orange-400 h-3 transition-all" style={{ width: `${generalPct}%` }} />
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── DM ── */}
        {menuItems.length > 0 && dryTotal > 0 && (
          <section className="bg-white rounded-xl shadow p-4 space-y-3">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5"><span>🔬</span> DM (乾物量ベース)</h2>
            <div className="grid grid-cols-5 gap-2 text-center">
              {[
                { label: "糖質", val: dm.carb, color: "bg-yellow-100 text-yellow-800" },
                { label: "タンパク質", val: dm.protein, color: "bg-red-100 text-red-700" },
                { label: "脂質", val: dm.fat, color: "bg-orange-100 text-orange-700" },
                { label: "粗繊維", val: dm.fiber, color: "bg-green-100 text-green-700" },
                { label: "灰分", val: dm.ash, color: "bg-gray-100 text-gray-600" },
              ].map((d) => (
                <div key={d.label} className={`${d.color} rounded-lg p-3`}>
                  <p className="text-[11px] opacity-70">{d.label}</p>
                  <p className="text-lg font-bold">{pct(d.val)}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Saved Menus ── */}
        {(() => {
          const dailyList = savedMenus
            .filter((m) => m.date)
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
          return (
            <>
              {dailyList.length > 0 && (
                <section className="bg-white rounded-xl shadow p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
                      <span>📅</span> 日付メニュー履歴
                    </h2>
                    <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                      <button
                        type="button"
                        onClick={() => setHistoryView("list")}
                        className={`text-xs px-2.5 py-1 rounded-md transition ${historyView === "list" ? "bg-white shadow font-medium" : "text-gray-500"}`}
                      >📋 リスト</button>
                      <button
                        type="button"
                        onClick={() => setHistoryView("calendar")}
                        className={`text-xs px-2.5 py-1 rounded-md transition ${historyView === "calendar" ? "bg-white shadow font-medium" : "text-gray-500"}`}
                      >📅 カレンダー</button>
                    </div>
                  </div>
                  {historyView === "calendar" && (() => {
                    const { year, month } = calendarMonth;
                    const firstDow = new Date(year, month, 1).getDay();
                    const daysInMonth = new Date(year, month + 1, 0).getDate();
                    const today = todayStr();
                    const byDate = {};
                    dailyList.forEach((m) => {
                      if (!byDate[m.date]) byDate[m.date] = [];
                      byDate[m.date].push(m);
                    });
                    const cells = [];
                    for (let i = 0; i < firstDow; i++) cells.push(null);
                    for (let d = 1; d <= daysInMonth; d++) {
                      const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                      cells.push({ day: d, dateStr: ds, entries: byDate[ds] || [] });
                    }
                    while (cells.length % 7 !== 0) cells.push(null);
                    const prevMonth = () => {
                      setCalendarMonth(month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 });
                      setCalendarSelectedDate(null);
                    };
                    const nextMonth = () => {
                      setCalendarMonth(month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 });
                      setCalendarSelectedDate(null);
                    };
                    const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <button onClick={prevMonth} className="text-amber-600 hover:bg-amber-50 rounded px-2 py-1 text-sm" aria-label="前の月">◀</button>
                          <span className="font-medium text-gray-700">{year}年{month + 1}月</span>
                          <button onClick={nextMonth} className="text-amber-600 hover:bg-amber-50 rounded px-2 py-1 text-sm" aria-label="次の月">▶</button>
                        </div>
                        <div className="grid grid-cols-7 gap-0.5 text-[10px] text-gray-500 text-center">
                          {weekdayLabels.map((w, i) => (
                            <div key={w} className={`py-0.5 ${i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : ""}`}>{w}</div>
                          ))}
                        </div>
                        <div className="grid grid-cols-7 gap-0.5">
                          {cells.map((c, idx) => {
                            if (!c) return <div key={`empty-${idx}`} className="aspect-square" />;
                            const isToday = c.dateStr === today;
                            const isSelected = c.dateStr === calendarSelectedDate;
                            const hasEntry = c.entries.length > 0;
                            const dow = idx % 7;
                            const dateColor = dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-gray-700";
                            return (
                              <button
                                key={c.dateStr}
                                type="button"
                                onClick={() => setCalendarSelectedDate(isSelected ? null : c.dateStr)}
                                className={`aspect-square flex flex-col items-start justify-start p-1 text-left rounded-md border transition ${
                                  isSelected ? "border-amber-500 bg-amber-100" :
                                  isToday ? "border-amber-400 bg-amber-50" :
                                  hasEntry ? "border-gray-200 bg-white hover:bg-amber-50" :
                                  "border-transparent hover:bg-gray-50"
                                }`}
                              >
                                <span className={`text-[11px] ${dateColor} ${isToday ? "font-bold" : ""}`}>{c.day}</span>
                                {hasEntry && (
                                  <div className="w-full flex-1 flex flex-col gap-0.5 mt-0.5 overflow-hidden">
                                    {c.entries.slice(0, 2).map((e) => (
                                      <span key={e.id} className="bg-amber-500 text-white text-[9px] px-1 rounded truncate leading-tight">{e.petName || "—"}</span>
                                    ))}
                                    {c.entries.length > 2 && (
                                      <span className="text-[9px] text-gray-400 leading-tight">+{c.entries.length - 2}</span>
                                    )}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {calendarSelectedDate && (() => {
                          const entries = byDate[calendarSelectedDate] || [];
                          const [y, mo, dd] = calendarSelectedDate.split("-").map(Number);
                          const label = `${mo}月${dd}日`;
                          return (
                            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                              <p className="text-xs text-gray-500">{label}のメニュー {entries.length > 0 ? `(${entries.length}件)` : ""}</p>
                              {entries.length === 0 ? (
                                <p className="text-xs text-gray-400 text-center py-2">この日のメニューはありません</p>
                              ) : entries.map((m) => (
                                <div key={m.id} className="bg-gray-50 rounded-lg px-3 py-3 space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium truncate">{m.petName || "未設定"}</span>
                                    <span className="text-xs text-gray-400 ml-auto shrink-0">{m.items?.length || 0}商品</span>
                                  </div>
                                  {m.note && editingMemoId !== m.id && (
                                    <p className="text-xs text-gray-600 bg-amber-50 px-2 py-1 rounded whitespace-pre-wrap">📝 {m.note}</p>
                                  )}
                                  {editingMemoId === m.id && (
                                    <div className="space-y-1.5">
                                      <textarea
                                        value={editingMemoDraft}
                                        onChange={(e) => setEditingMemoDraft(e.target.value)}
                                        placeholder="例: 朝は食欲なし、午後完食"
                                        rows={2}
                                        autoFocus
                                        className="w-full text-xs border border-amber-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-amber-400 focus:outline-none bg-amber-50"
                                      />
                                      <div className="flex items-center gap-2 justify-end">
                                        <button
                                          onClick={async () => {
                                            await updateMenuNote(m.id, editingMemoDraft);
                                            setEditingMemoId(null);
                                            setEditingMemoDraft("");
                                          }}
                                          className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1 rounded-lg transition"
                                        >保存</button>
                                        <button
                                          onClick={() => { setEditingMemoId(null); setEditingMemoDraft(""); }}
                                          className="text-gray-400 hover:text-gray-600 text-xs px-2 py-1"
                                        >キャンセル</button>
                                      </div>
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2 justify-end">
                                    <button
                                      onClick={() => loadMenu(m)}
                                      className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg transition"
                                    >表示する</button>
                                    <button
                                      onClick={() => {
                                        if (editingMemoId === m.id) {
                                          setEditingMemoId(null);
                                          setEditingMemoDraft("");
                                        } else {
                                          setEditingMemoId(m.id);
                                          setEditingMemoDraft(m.note || "");
                                        }
                                      }}
                                      className="bg-white border border-amber-400 text-amber-700 hover:bg-amber-50 text-xs px-3 py-1.5 rounded-lg transition"
                                    >{m.note ? "📝 メモ編集" : "＋ メモ"}</button>
                                    <button
                                      onClick={() => deleteSavedMenu(m.id)}
                                      className="text-red-400 hover:text-red-600 text-xs px-2 py-1.5"
                                    >削除</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}
                  {historyView === "list" && (
                  <ul className="space-y-2">
                    {dailyList.map((m) => {
                      const d = new Date(m.date + "T00:00:00");
                      const dateLabel = `${d.getMonth() + 1}月${d.getDate()}日`;
                      return (
                        <li key={m.id} className="bg-gray-50 rounded-lg px-3 py-3 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded font-medium">{dateLabel}</span>
                            <span className="font-medium truncate">{m.petName || "未設定"}</span>
                            <span className="text-xs text-gray-400 ml-auto shrink-0">{m.items?.length || 0}商品</span>
                          </div>
                          {m.note && editingMemoId !== m.id && (
                            <p className="text-xs text-gray-600 bg-amber-50 px-2 py-1 rounded whitespace-pre-wrap">📝 {m.note}</p>
                          )}
                          {editingMemoId === m.id && (
                            <div className="space-y-1.5">
                              <textarea
                                value={editingMemoDraft}
                                onChange={(e) => setEditingMemoDraft(e.target.value)}
                                placeholder="例: 朝は食欲なし、午後完食"
                                rows={2}
                                autoFocus
                                className="w-full text-xs border border-amber-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-amber-400 focus:outline-none bg-amber-50"
                              />
                              <div className="flex items-center gap-2 justify-end">
                                <button
                                  onClick={async () => {
                                    await updateMenuNote(m.id, editingMemoDraft);
                                    setEditingMemoId(null);
                                    setEditingMemoDraft("");
                                  }}
                                  className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1 rounded-lg transition"
                                >保存</button>
                                <button
                                  onClick={() => { setEditingMemoId(null); setEditingMemoDraft(""); }}
                                  className="text-gray-400 hover:text-gray-600 text-xs px-2 py-1"
                                >キャンセル</button>
                              </div>
                            </div>
                          )}
                          <div className="flex items-center gap-2 justify-end">
                            <button
                              onClick={() => loadMenu(m)}
                              className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg transition"
                            >表示する</button>
                            <button
                              onClick={() => {
                                if (editingMemoId === m.id) {
                                  setEditingMemoId(null);
                                  setEditingMemoDraft("");
                                } else {
                                  setEditingMemoId(m.id);
                                  setEditingMemoDraft(m.note || "");
                                }
                              }}
                              className="bg-white border border-amber-400 text-amber-700 hover:bg-amber-50 text-xs px-3 py-1.5 rounded-lg transition"
                            >{m.note ? "📝 メモ編集" : "＋ メモ"}</button>
                            <button
                              onClick={() => deleteSavedMenu(m.id)}
                              className="text-red-400 hover:text-red-600 text-xs px-2 py-1.5"
                            >削除</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  )}
                </section>
              )}
              {dailyList.length > 0 && (() => {
                const petNames = [...new Set(dailyList.map((m) => m.petName).filter(Boolean))];
                const from = statFrom || (() => {
                  const d = new Date(); d.setDate(d.getDate() - 6);
                  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                })();
                const to = statTo || todayStr();
                const filtered = dailyList.filter((m) => {
                  if (m.date < from || m.date > to) return false;
                  if (statPet !== "__all__" && m.petName !== statPet) return false;
                  return true;
                });
                const kcalOf = (items) => (items || []).reduce((acc, it) => {
                  const kPer100 = it.food?.kcalPer100g || 0;
                  const amt = it.amount || 0;
                  return acc + (kPer100 * amt) / 100;
                }, 0);
                const perDate = {};
                filtered.forEach((m) => {
                  const k = kcalOf(m.items);
                  if (!perDate[m.date]) perDate[m.date] = 0;
                  perDate[m.date] += k;
                });
                const rangeDates = [];
                {
                  const sd = new Date(from + "T00:00:00");
                  const ed = new Date(to + "T00:00:00");
                  for (let cur = new Date(sd); cur <= ed; cur.setDate(cur.getDate() + 1)) {
                    rangeDates.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
                  }
                }
                const includedDates = rangeDates.filter((d) => (perDate[d] || 0) > 0);
                const excludedDates = rangeDates.filter((d) => !((perDate[d] || 0) > 0));
                const days = includedDates.length;
                const totalKcal = includedDates.reduce((s, d) => s + perDate[d], 0);
                const avg = days > 0 ? totalKcal / days : 0;
                const fmtDateShort = (ds) => {
                  const [, mo, dd] = ds.split("-").map(Number);
                  return `${mo}月${dd}日`;
                };
                return (
                  <section className="bg-white rounded-xl shadow p-4 space-y-3">
                    <button
                      type="button"
                      onClick={() => setShowStats((s) => !s)}
                      className="w-full flex items-center justify-between"
                    >
                      <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
                        <span>📊</span> 期間平均カロリー
                      </h2>
                      <span className="text-amber-600 text-sm">{showStats ? "▲" : "▼"}</span>
                    </button>
                    {showStats && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="text-xs text-gray-500">開始日</span>
                            <input
                              type="date"
                              value={from}
                              onChange={(e) => setStatFrom(e.target.value)}
                              className="mt-0.5 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-gray-500">終了日</span>
                            <input
                              type="date"
                              value={to}
                              onChange={(e) => setStatTo(e.target.value)}
                              className="mt-0.5 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                            />
                          </label>
                        </div>
                        {petNames.length > 1 && (
                          <label className="block">
                            <span className="text-xs text-gray-500">ペット</span>
                            <select
                              value={statPet}
                              onChange={(e) => setStatPet(e.target.value)}
                              className="mt-0.5 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                            >
                              <option value="__all__">全員</option>
                              {petNames.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                          </label>
                        )}
                        <div className="bg-amber-50 rounded-lg p-3 grid grid-cols-3 gap-2 text-center">
                          <div>
                            <p className="text-[10px] text-gray-500">1日平均</p>
                            <p className="text-lg font-bold text-amber-700">{fmt(avg)} <span className="text-xs font-normal">kcal</span></p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500">合計</p>
                            <p className="text-lg font-bold text-amber-700">{fmt(totalKcal)} <span className="text-xs font-normal">kcal</span></p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500">対象日数</p>
                            <p className="text-lg font-bold text-amber-700">{days} <span className="text-xs font-normal">日</span></p>
                          </div>
                        </div>
                        {days === 0 && (
                          <p className="text-xs text-gray-400 text-center">この期間のメニューはありません</p>
                        )}
                        {excludedDates.length > 0 && days > 0 && (
                          <p className="text-[11px] text-gray-500 leading-relaxed">
                            備考: {excludedDates.map(fmtDateShort).join("、")}は入力がなかったため除外しています
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                );
              })()}
            </>
          );
        })()}

        {/* ── Save / Export / Reset ── */}
        <div className="space-y-3 pb-6">
          {/* Save menu button / form */}
          {!showSaveForm ? (
            <button
              onClick={() => {
                setShowSaveForm(true);
                if (!saveDate) setSaveDate(todayStr());
                if (!savePet) setSavePet(petName || "");
              }}
              className="w-full bg-white border-2 border-amber-400 text-amber-700 hover:bg-amber-50 py-3 rounded-xl font-medium transition flex items-center justify-center gap-2"
            >
              <span>💾</span> このメニューを登録する
            </button>
          ) : (
            <div className="bg-white border-2 border-amber-400 rounded-xl p-4 space-y-3">
                <div className="space-y-2">
                  <label className="block">
                    <span className="text-xs text-gray-500">日付</span>
                    <input
                      type="date"
                      value={saveDate}
                      onChange={(e) => setSaveDate(e.target.value)}
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-500">ペット名 {petNameCandidates.length > 0 && <span className="text-gray-400">（過去入力から選択可）</span>}</span>
                    <input
                      type="text"
                      list="pet-name-options"
                      value={savePet}
                      onChange={(e) => setSavePet(e.target.value)}
                      placeholder="例: ぽち"
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    />
                    <datalist id="pet-name-options">
                      {petNameCandidates.map((p) => <option key={p} value={p} />)}
                    </datalist>
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-500">メモ（その日の体調・食欲など）</span>
                    <textarea
                      value={saveMemo}
                      onChange={(e) => setSaveMemo(e.target.value)}
                      placeholder="例: 朝は食欲なし、午後完食"
                      rows={2}
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={saveCurrentMenu}
                      disabled={!saveDate || !(savePet || petName).trim()}
                      className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg font-medium transition"
                    >この日のメニューとして保存</button>
                    <button
                      onClick={() => { setShowSaveForm(false); setSaveDate(""); setSavePet(""); setSaveMemo(""); }}
                      className="text-gray-400 hover:text-gray-600 px-2"
                    >×</button>
                  </div>
                  <p className="text-[11px] text-gray-400">同じ日付・同じペット名で保存済みがあれば自動上書き</p>
                </div>
            </div>
          )}

          {/* Overwrite menu button */}
          {loadedMenuId && (
            <button
              onClick={overwriteMenu}
              className="w-full bg-white border-2 border-blue-400 text-blue-700 hover:bg-blue-50 py-3 rounded-xl font-medium transition flex items-center justify-center gap-2"
            >
              <span>📝</span> このメニューを上書きする
              <span className="text-xs text-blue-400">({savedMenus.find((m) => m.id === loadedMenuId)?.name})</span>
            </button>
          )}

          {/* New menu button */}
          <button
            onClick={() => { setMenuItems([]); setLoadedMenuId(null); }}
            className="w-full bg-white border-2 border-gray-300 text-gray-600 hover:bg-gray-50 py-3 rounded-xl font-medium transition flex items-center justify-center gap-2"
          >
            <span>✨</span> 新しいメニューを作る
          </button>

          {/* Export & Reset & Settings row */}
          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <button
                onClick={() => setShowResetConfirm(true)}
                className="text-sm text-red-400 hover:text-red-600 px-3 py-1.5 transition"
              >🗑 リセット</button>
              <button
                onClick={() => setShowApiSettings(!showApiSettings)}
                className="text-sm text-gray-400 hover:text-gray-600 px-2 py-1.5 transition"
              >⚙ 設定</button>
            </div>
            <div className="flex gap-2">
              <label className="text-sm border border-gray-300 hover:bg-gray-100 px-4 py-1.5 rounded-lg transition cursor-pointer">
                CSV インポート
                <input type="file" accept=".csv" onChange={importCSV} className="hidden" />
              </label>
              <button
                onClick={() => exportCSV(petName, weight, der, waterNeed, menuItems, totals, dm, petType)}
                className="text-sm border border-gray-300 hover:bg-gray-100 px-4 py-1.5 rounded-lg transition"
              >CSV エクスポート</button>
            </div>
          </div>

          {/* API Settings */}
          {showApiSettings && (
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 border">
              <p className="text-sm font-medium text-gray-700">⚙ 設定</p>
              <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700 space-y-1">
                <p>📷 成分表の画像読み取りは<strong>登録なし</strong>でも使えます。</p>
                <p>Gemini APIキーを設定すると、より高精度な読み取りが可能になります。</p>
              </div>
              <label className="block">
                <span className="text-xs text-gray-500">Gemini APIキー（高精度モード・任意）</span>
                <div className="flex gap-2 mt-1">
                  <input type="password"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    placeholder="AIza..."
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)} />
                  <button onClick={() => { saveApiKey(geminiKey); alert("保存しました"); }}
                    className="bg-amber-600 hover:bg-amber-700 text-white text-sm px-4 py-2 rounded-lg transition"
                  >保存</button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                    className="text-blue-500 underline hover:text-blue-700">Google AI Studio（https://aistudio.google.com/apikey）</a>
                  で無料で取得できます。APIキーは端末内にのみ保存されます。
                </p>
              </label>

              {/* Cloud backup */}
              <div className="border-t pt-3 mt-3 space-y-2">
                <p className="text-sm font-medium text-gray-700">☁ クラウドバックアップ</p>
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-1">
                  <p className="text-xs text-green-700">自動バックアップ有効</p>
                  <p className="text-[10px] text-gray-500">データは自動で保存・復元されます。別の端末で使う場合は以下のコードを入力してください。</p>
                  <p className="text-lg font-mono font-bold text-green-800 tracking-widest">{backupCode}</p>
                </div>
                <div className="flex gap-2">
                  <input type="text" placeholder="別端末の復元コード" maxLength={6}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono uppercase focus:ring-2 focus:ring-green-400 focus:outline-none"
                    value={restoreCode} onChange={(e) => setRestoreCode(e.target.value.toUpperCase())} />
                  <button onClick={async () => { if (restoreCode.length >= 4) await restoreFromCloud(restoreCode); }}
                    disabled={restoreCode.length < 4}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm px-4 py-2 rounded-lg transition"
                  >復元</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ═══════════════════════════════════════════
         Add Food Dialog
         ═══════════════════════════════════════════ */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg text-amber-700">商品を追加</h3>
                <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
              </div>

              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                <button onClick={() => setAddMode("select")}
                  className={`flex-1 text-sm py-1.5 rounded-md transition ${addMode === "select" ? "bg-white shadow font-medium" : "text-gray-500"}`}
                >保存済みから選択</button>
                <button onClick={() => setAddMode("new")}
                  className={`flex-1 text-sm py-1.5 rounded-md transition ${addMode === "new" ? "bg-white shadow font-medium" : "text-gray-500"}`}
                >新しい商品を登録</button>
              </div>

              {addMode === "select" ? (
                <div className="space-y-3">
                  {foodMaster.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-4">
                      保存済みの商品がありません。<br />「新しい商品を登録」から追加してください。
                    </p>
                  ) : (
                    <>
                      <select className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                        value={selectedMasterId} onChange={(e) => setSelectedMasterId(e.target.value)}>
                        <option value="">商品を選んでください</option>
                        {foodMaster.map((f) => (
                          <option key={f.id} value={f.id}>{f.name} ({f.kcalPer100g} kcal/100g)</option>
                        ))}
                      </select>

                      {selectedMasterId && (() => {
                        const sel = foodMaster.find((f) => f.id === selectedMasterId);
                        if (!sel) return null;
                        const carb = calcCarbs(sel.protein, sel.fat, sel.fiber, sel.ash, sel.moisture);
                        return (
                          <div className="bg-amber-50 rounded-lg p-3 text-xs grid grid-cols-3 gap-1">
                            <span>タンパク: {fmt(sel.protein)}%</span>
                            <span>脂質: {fmt(sel.fat)}%</span>
                            <span>粗繊維: {fmt(sel.fiber)}%</span>
                            <span>灰分: {fmt(sel.ash)}%</span>
                            <span>水分: {fmt(sel.moisture)}%</span>
                            <span>糖質: {fmt(carb)}%</span>
                          </div>
                        );
                      })()}

                      <label className="block">
                        <span className="text-xs text-gray-500">給餌量 (g)</span>
                        <input type="number" min="0" step="1"
                          className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          placeholder="例: 40" value={addAmount} onChange={(e) => setAddAmount(e.target.value)} />
                      </label>
                      <button onClick={addFromMaster} disabled={!selectedMasterId || !addAmount}
                        className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white py-2 rounded-lg font-medium transition"
                      >追加する</button>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-xs text-gray-500">商品名</span>
                    <input className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                      placeholder="例: ヒルズ I/D 消化ケア"
                      value={newFood.name} onChange={(e) => setNewFood((p) => ({ ...p, name: e.target.value }))} />
                  </label>
                  <button onClick={aiAutoFill} disabled={aiSearching || !newFood.name.trim()}
                    className="w-full flex flex-col items-center justify-center gap-0.5 border-2 border-dashed border-blue-300 hover:border-blue-400 hover:bg-blue-50 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400 rounded-lg py-2 cursor-pointer transition text-sm text-blue-600"
                  >
                    <div className="flex items-center gap-2">
                      <span>{aiSearching ? "⏳" : "🤖"}</span>
                      <span>{aiSearching ? "検索中..." : "AIで自動入力"}</span>
                    </div>
                    {!aiSearching && (
                      <span className="text-[10px] text-gray-400">
                        {geminiKey
                          ? "自分のAPIキー使用・無制限"
                          : (searchRemaining != null ? `残り${searchRemaining}回（1日5回まで）` : "1日5回まで")}　※100%正確とは限りません
                      </span>
                    )}
                  </button>
                  {/* Image scan button */}
                  <label className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed rounded-lg py-3 cursor-pointer transition ${
                    scanning ? "border-amber-400 bg-amber-50" : "border-gray-300 hover:border-amber-400 hover:bg-amber-50"
                  }`}>
                    <div className="flex items-center gap-2">
                      <span>{scanning ? "⏳" : "📷"}</span>
                      <span className="text-sm text-gray-600">
                        {scanning ? "読み取り中..." : "成分表を撮影して自動入力"}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-400">
                      {geminiKey
                        ? "Gemini AI（自分のキー・無制限）"
                        : (scanRemaining != null ? `Gemini AI（高精度）・残り${scanRemaining}回（1日5回まで）` : "Gemini AI（高精度）・1日5回まで")}
                    </span>
                    <input type="file" accept="image/*" capture="environment" onChange={scanFoodLabel}
                      disabled={scanning} className="hidden" />
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={newFood.isComplete}
                      onChange={(e) => setNewFood((p) => ({ ...p, isComplete: e.target.checked }))}
                      className="w-4 h-4 accent-amber-600 rounded" />
                    <span className="text-sm text-gray-700">総合栄養食</span>
                    <span className="text-[11px] text-gray-400">（チェックなし＝一般食・おやつ）</span>
                  </label>

                  <p className="text-xs text-gray-500 font-medium">成分 (すべて%)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "protein", label: "タンパク質" },
                      { key: "fat", label: "脂質" },
                      { key: "fiber", label: "粗繊維" },
                      { key: "ash", label: "灰分" },
                      { key: "moisture", label: "水分" },
                    ].map(({ key, label }) => (
                      <label key={key} className="block">
                        <span className="text-[11px] text-gray-400">{label} (%)</span>
                        <input type="number" step="0.1" min="0" max="100"
                          className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          value={newFood[key]} onChange={(e) => setNewFood((p) => ({ ...p, [key]: e.target.value }))} />
                      </label>
                    ))}
                    <div className="col-span-2">
                      <p className="text-[11px] text-gray-400 mb-1">カロリー（何gで何kcal？）</p>
                      <div className="flex items-center gap-1.5">
                        <input type="number" step="1" min="0" placeholder="70"
                          className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          value={newFood.kcalGrams} onChange={(e) => setNewFood((p) => ({ ...p, kcalGrams: e.target.value }))} />
                        <span className="text-xs text-gray-500">g で</span>
                        <input type="number" step="0.1" min="0" placeholder="50"
                          className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          value={newFood.kcalValue} onChange={(e) => setNewFood((p) => ({ ...p, kcalValue: e.target.value }))} />
                        <span className="text-xs text-gray-500">kcal</span>
                      </div>
                      {parseFloat(newFood.kcalGrams) > 0 && parseFloat(newFood.kcalValue) >= 0 && (
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          → {fmt((parseFloat(newFood.kcalValue) / parseFloat(newFood.kcalGrams)) * 100)} kcal/100g
                        </p>
                      )}
                    </div>
                  </div>
                  {newFood.protein && (
                    <p className="text-xs text-gray-500">
                      糖質(自動): {fmt(calcCarbs(
                        parseFloat(newFood.protein) || 0, parseFloat(newFood.fat) || 0,
                        parseFloat(newFood.fiber) || 0, parseFloat(newFood.ash) || 0,
                        parseFloat(newFood.moisture) || 0
                      ))}%
                    </p>
                  )}
                  <label className="block">
                    <span className="text-xs text-gray-500">給餌量 (g)</span>
                    <input type="number" min="0" step="1"
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                      placeholder="例: 40" value={addAmount} onChange={(e) => setAddAmount(e.target.value)} />
                  </label>
                  <button onClick={addNewFood} disabled={!newFood.name || !addAmount}
                    className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white py-2 rounded-lg font-medium transition"
                  >登録して追加する</button>
                </div>
              )}

              {foodMaster.length > 0 && (
                <details className="pt-2">
                  <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
                    保存済み商品の管理 ({foodMaster.length}件)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {foodMaster.map((f) => (
                      <li key={f.id} className="text-sm bg-gray-50 rounded px-3 py-2">
                        {editingFoodId === f.id ? (
                          <div className="space-y-2">
                            <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-amber-400 focus:outline-none"
                              value={editFood.name} onChange={(e) => setEditFood((p) => ({ ...p, name: e.target.value }))} />
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={editFood.isComplete}
                                onChange={(e) => setEditFood((p) => ({ ...p, isComplete: e.target.checked }))}
                                className="w-3.5 h-3.5 accent-amber-600" />
                              <span className="text-xs text-gray-600">総合栄養食</span>
                            </label>
                            <div className="grid grid-cols-3 gap-1">
                              {[
                                { key: "protein", label: "タンパク%" }, { key: "fat", label: "脂質%" },
                                { key: "fiber", label: "繊維%" }, { key: "ash", label: "灰分%" },
                                { key: "moisture", label: "水分%" },
                              ].map(({ key, label }) => (
                                <input key={key} type="number" step="0.1" min="0" max="100" placeholder={label}
                                  className="border border-gray-300 rounded px-1.5 py-1 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                                  value={editFood[key]} onChange={(e) => setEditFood((p) => ({ ...p, [key]: e.target.value }))} />
                              ))}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-500">
                              <span>現在: {fmt(editFood.kcalPer100g)} kcal/100g</span>
                              <span className="mx-1">→ 変更:</span>
                              <input type="number" step="1" min="0" placeholder="g"
                                className="w-14 border border-gray-300 rounded px-1 py-0.5 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                                value={editFood.kcalGrams} onChange={(e) => setEditFood((p) => ({ ...p, kcalGrams: e.target.value }))} />
                              <span>gで</span>
                              <input type="number" step="0.1" min="0" placeholder="kcal"
                                className="w-14 border border-gray-300 rounded px-1 py-0.5 text-xs focus:ring-1 focus:ring-amber-400 focus:outline-none"
                                value={editFood.kcalValue} onChange={(e) => setEditFood((p) => ({ ...p, kcalValue: e.target.value }))} />
                              <span>kcal</span>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={saveEditFood}
                                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-xs py-1.5 rounded transition">保存</button>
                              <button onClick={() => setEditingFoodId(null)}
                                className="flex-1 border border-gray-300 text-xs py-1.5 rounded hover:bg-gray-100 transition">キャンセル</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button onClick={() => startEditFood(f)}
                              className="bg-amber-100 hover:bg-amber-200 text-amber-700 text-[11px] px-2 py-1 rounded transition shrink-0">編集</button>
                            <div className="truncate flex-1">
                              <span>{f.name}</span>
                              <span className="text-xs text-gray-400 ml-1">({fmt(f.kcalPer100g)} kcal/100g)</span>
                              {f.isComplete && <span className="text-[10px] ml-1 px-1 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">総合</span>}
                            </div>
                            <button onClick={() => removeMasterFood(f.id)} className="text-red-400 hover:text-red-600 text-xs px-1 shrink-0">削除</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════
         Reset Confirm Dialog
         ═══════════════════════════════════════════ */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowResetConfirm(false)}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6 space-y-4 text-center">
            <p className="text-4xl">⚠️</p>
            <h3 className="font-bold text-lg">データをリセットしますか？</h3>
            <p className="text-sm text-gray-500">
              すべてのメニュー・保存済み商品・ペット情報が削除されます。<br />この操作は取り消せません。
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowResetConfirm(false)}
                className="flex-1 border border-gray-300 py-2 rounded-lg text-sm hover:bg-gray-50 transition"
              >キャンセル</button>
              <button onClick={resetAllData}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2 rounded-lg text-sm font-medium transition"
              >リセットする</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
