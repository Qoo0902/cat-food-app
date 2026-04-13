import { useState, useEffect, useCallback } from "react";
import Tesseract from "tesseract.js";

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

/* ─── Calculation helpers ─── */
const calcDER = (w) => (w > 0 ? 70 * Math.pow(w, 0.75) * 0.84 : 0);

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

/* ─── CSV export ─── */
function exportCSV(petName, weight, der, waterNeed, items, totals, dm) {
  const rows = [
    ["猫の食事管理レポート"],
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
export default function CatFoodCalculator() {
  /* ─── Current editing state ─── */
  const [petName, setPetName] = useState("");
  const [weight, setWeight] = useState("");
  const [foodMaster, setFoodMaster] = useState([]);
  const [menuItems, setMenuItems] = useState([]);

  /* ─── Saved menus ─── */
  const [savedMenus, setSavedMenus] = useState([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveMenuName, setSaveMenuName] = useState("");
  const [loadedMenuId, setLoadedMenuId] = useState(null); // currently loaded menu ID

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

  /* ─── Load ─── */
  useEffect(() => {
    (async () => {
      const master = await store.get("food-master") || [];
      const WATER = { id: "__water__", name: "水", protein: 0, fat: 0, fiber: 0, ash: 0, moisture: 100, kcalPer100g: 0, isComplete: false };
      if (!master.find((f) => f.id === "__water__")) master.unshift(WATER);
      setFoodMaster(master);

      const current = await store.get("current-menu");
      if (current) {
        setPetName(current.petName || "");
        setWeight(current.weight || "");
        setMenuItems(current.items || []);
      }

      const saved = await store.get("saved-menus");
      if (saved) setSavedMenus(saved);

      const apiKey = await store.get("gemini-api-key");
      if (apiKey) setGeminiKey(apiKey);

      setLoaded(true);
    })();
  }, []);

  /* ─── Auto-save current editing state ─── */
  useEffect(() => {
    if (!loaded) return;
    store.set("current-menu", {
      petName,
      weight: parseFloat(weight) || 0,
      items: menuItems,
    });
  }, [petName, weight, menuItems, loaded]);

  /* ─── Save master ─── */
  const saveMaster = useCallback(async (m) => {
    setFoodMaster(m);
    await store.set("food-master", m);
  }, []);

  /* ─── Save current menu with a name ─── */
  const saveCurrentMenu = useCallback(async () => {
    if (!saveMenuName.trim()) return;
    const newSaved = {
      id: uid(),
      name: saveMenuName.trim(),
      petName,
      weight: parseFloat(weight) || 0,
      items: [...menuItems],
      savedAt: new Date().toISOString(),
    };
    const updated = [...savedMenus, newSaved];
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
    setSaveMenuName("");
    setShowSaveForm(false);
  }, [saveMenuName, petName, weight, menuItems, savedMenus]);

  /* ─── Load a saved menu ─── */
  const loadMenu = useCallback((menu) => {
    setPetName(menu.petName || "");
    setWeight(menu.weight ? String(menu.weight) : "");
    setMenuItems(menu.items || []);
    setLoadedMenuId(menu.id);
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
  }, [loadedMenuId, savedMenus, petName, weight, menuItems]);

  /* ─── Delete a saved menu ─── */
  const deleteSavedMenu = useCallback(async (menuId) => {
    const updated = savedMenus.filter((m) => m.id !== menuId);
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
  }, [savedMenus]);

  /* ─── Reorder saved menus ─── */
  const moveSavedMenu = useCallback(async (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= savedMenus.length) return;
    const updated = [...savedMenus];
    [updated[index], updated[target]] = [updated[target], updated[index]];
    setSavedMenus(updated);
    await store.set("saved-menus", updated);
  }, [savedMenus]);

  /* ─── Reset all data ─── */
  const resetAllData = useCallback(async () => {
    await store.remove("current-menu");
    await store.remove("food-master");
    await store.remove("saved-menus");
    // Also clean up old format keys
    await store.remove("menus-list");
    await store.remove("active-menu-id");

    setPetName("");
    setWeight("");
    setMenuItems([]);
    setFoodMaster([]);
    setSavedMenus([]);
    setShowResetConfirm(false);
  }, []);

  /* ─── Derived ─── */
  const w = parseFloat(weight) || 0;
  const der = calcDER(w);
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

      let imported = 0, skipped = 0;
      const existingNames = new Set(foodMaster.map((f) => f.name));
      const newItems = [];

      const SKIP_NAMES = /^(合計|DM|糖質|タンパク質|脂質|粗繊維|灰分|水分|[\d.]+%?)$/;
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim());
        const name = cols[nameIdx];
        if (!name || name === "合計") break; // 合計行以降は集計データなので終了
        if (SKIP_NAMES.test(name)) continue;
        if (existingNames.has(name)) { skipped++; continue; }

        newItems.push({
          id: uid(),
          name,
          protein: parseFloat(cols[proteinIdx]) || 0,
          fat: parseFloat(cols[fatIdx]) || 0,
          fiber: parseFloat(cols[fiberIdx]) || 0,
          ash: parseFloat(cols[ashIdx]) || 0,
          moisture: parseFloat(cols[moistureIdx]) || 0,
          kcalPer100g: parseFloat(cols[kcalIdx]) || 0,
          isComplete: completeIdx >= 0 ? /true|1|○|はい|yes/i.test(cols[completeIdx]) : false,
        });
        existingNames.add(name);
        imported++;
      }

      if (newItems.length > 0) saveMaster([...foodMaster, ...newItems]);
      alert(`${imported}件インポート${skipped > 0 ? `、${skipped}件スキップ（重複）` : ""}`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  /* ─── Save Gemini API key ─── */
  const saveApiKey = useCallback(async (key) => {
    setGeminiKey(key);
    await store.set("gemini-api-key", key);
  }, []);

  /* ─── Scan food label image (Gemini or Tesseract) ─── */
  const scanWithGemini = async (file) => {
    const base64 = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.readAsDataURL(file);
    });
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
      if (geminiKey) {
        parsed = await scanWithGemini(file);
      } else {
        parsed = await scanWithTesseract(file);
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
        alert("成分表を読み取りました！内容を確認してください。");
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
          <span className="text-3xl">🐱</span>
          <div>
            <h1 className="text-lg font-bold leading-tight">くぅのキャットフード研究室</h1>
            <p className="text-amber-100 text-xs">猫の食事管理アプリ</p>
          </div>
        </div>
      </header>

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
        {savedMenus.length > 0 && (
          <section className="bg-white rounded-xl shadow p-4 space-y-3">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
              <span>📋</span> 保存済みメニュー
            </h2>
            <ul className="space-y-2">
              {savedMenus.map((m, idx) => (
                <li key={m.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-3">
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveSavedMenu(idx, -1)}
                      disabled={idx === 0}
                      className="text-gray-400 hover:text-amber-600 disabled:opacity-20 text-sm leading-none p-0.5 transition"
                      aria-label="上に移動"
                    >▲</button>
                    <button
                      onClick={() => moveSavedMenu(idx, 1)}
                      disabled={idx === savedMenus.length - 1}
                      className="text-gray-400 hover:text-amber-600 disabled:opacity-20 text-sm leading-none p-0.5 transition"
                      aria-label="下に移動"
                    >▼</button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{m.name}</p>
                    <p className="text-xs text-gray-400">
                      {m.petName || "未設定"} / {m.items?.length || 0}商品
                      {m.savedAt && ` / ${new Date(m.savedAt).toLocaleDateString("ja-JP")}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => loadMenu(m)}
                      className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg transition"
                    >読み込む</button>
                    <button
                      onClick={() => deleteSavedMenu(m.id)}
                      className="text-red-400 hover:text-red-600 text-xs px-2 py-1.5"
                    >削除</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Save / Export / Reset ── */}
        <div className="space-y-3 pb-6">
          {/* Save menu button / form */}
          {!showSaveForm ? (
            <button
              onClick={() => setShowSaveForm(true)}
              className="w-full bg-white border-2 border-amber-400 text-amber-700 hover:bg-amber-50 py-3 rounded-xl font-medium transition flex items-center justify-center gap-2"
            >
              <span>💾</span> このメニューを登録する
            </button>
          ) : (
            <div className="bg-white border-2 border-amber-400 rounded-xl p-4 space-y-3">
              <p className="font-medium text-amber-700 text-sm">メニュー名を入力してください</p>
              <div className="flex gap-2">
                <input
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  placeholder="例: 療法食メニュー"
                  value={saveMenuName}
                  onChange={(e) => setSaveMenuName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveCurrentMenu()}
                  autoFocus
                />
                <button
                  onClick={saveCurrentMenu}
                  disabled={!saveMenuName.trim()}
                  className="bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg font-medium transition"
                >保存</button>
                <button
                  onClick={() => { setShowSaveForm(false); setSaveMenuName(""); }}
                  className="text-gray-400 hover:text-gray-600 px-2"
                >×</button>
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
            onClick={() => { setPetName(""); setWeight(""); setMenuItems([]); setLoadedMenuId(null); }}
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
                onClick={() => exportCSV(petName, weight, der, waterNeed, menuItems, totals, dm)}
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
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={newFood.isComplete}
                      onChange={(e) => setNewFood((p) => ({ ...p, isComplete: e.target.checked }))}
                      className="w-4 h-4 accent-amber-600 rounded" />
                    <span className="text-sm text-gray-700">総合栄養食</span>
                    <span className="text-[11px] text-gray-400">（チェックなし＝一般食・おやつ）</span>
                  </label>

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
                      {geminiKey ? "Gemini AI（高精度）" : "登録不要・そのまま使えます"}
                    </span>
                    <input type="file" accept="image/*" capture="environment" onChange={scanFoodLabel}
                      disabled={scanning} className="hidden" />
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
