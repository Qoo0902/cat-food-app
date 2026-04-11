import { useState, useEffect, useCallback } from "react";

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
  kcalPerG: "",
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
      "商品名",
      "糖質(%)",
      "タンパク質(%)",
      "脂質(%)",
      "粗繊維(%)",
      "灰分(%)",
      "水分(%)",
      "kcal/g",
      "給餌量(g)",
      "合計カロリー(kcal)",
      "水分(ml)",
    ],
  ];

  items.forEach((it) => {
    const f = it.food;
    const carb = calcCarbs(f.protein, f.fat, f.fiber, f.ash, f.moisture);
    rows.push([
      f.name,
      fmt(carb),
      fmt(f.protein),
      fmt(f.fat),
      fmt(f.fiber),
      fmt(f.ash),
      fmt(f.moisture),
      fmt(f.kcalPerG),
      fmt(it.amount),
      fmt(f.kcalPerG * it.amount),
      fmt((it.amount * f.moisture) / 100),
    ]);
  });

  rows.push([
    "合計",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    fmt(totals.amount),
    fmt(totals.kcal),
    fmt(totals.water),
  ]);

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
  const [petName, setPetName] = useState("");
  const [weight, setWeight] = useState("");
  const [foodMaster, setFoodMaster] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState("select"); // "select" | "new"
  const [selectedMasterId, setSelectedMasterId] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [newFood, setNewFood] = useState({ ...EMPTY_FOOD });
  const [loaded, setLoaded] = useState(false);

  /* ─── Load ─── */
  useEffect(() => {
    (async () => {
      const master = await store.get("food-master");
      if (master) setFoodMaster(master);
      const menu = await store.get("current-menu");
      if (menu) {
        setPetName(menu.petName || "");
        setWeight(menu.weight || "");
        setMenuItems(menu.items || []);
      }
      setLoaded(true);
    })();
  }, []);

  /* ─── Save ─── */
  const saveMaster = useCallback(
    async (m) => {
      setFoodMaster(m);
      await store.set("food-master", m);
    },
    []
  );

  useEffect(() => {
    if (!loaded) return;
    store.set("current-menu", {
      petName,
      weight: parseFloat(weight) || 0,
      items: menuItems,
    });
  }, [petName, weight, menuItems, loaded]);

  /* ─── Derived ─── */
  const w = parseFloat(weight) || 0;
  const der = calcDER(w);
  const waterNeed = der;

  const enriched = menuItems.map((it) => {
    const f = it.food;
    const carb = calcCarbs(f.protein, f.fat, f.fiber, f.ash, f.moisture);
    const amt = it.amount || 0;
    return {
      ...it,
      carb,
      totalKcal: f.kcalPerG * amt,
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
      id: uid(),
      name: newFood.name,
      protein: parseFloat(newFood.protein) || 0,
      fat: parseFloat(newFood.fat) || 0,
      fiber: parseFloat(newFood.fiber) || 0,
      ash: parseFloat(newFood.ash) || 0,
      moisture: parseFloat(newFood.moisture) || 0,
      kcalPerG: parseFloat(newFood.kcalPerG) || 0,
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

  /* ─── Status color helpers ─── */
  const kcalStatus =
    menuItems.length === 0
      ? "text-gray-400"
      : Math.abs(kcalDiff) <= der * 0.05
      ? "text-emerald-600"
      : kcalDiff < 0
      ? "text-amber-600"
      : "text-red-500";

  const waterStatus =
    menuItems.length === 0
      ? "text-gray-400"
      : waterDiff >= 0
      ? "text-emerald-600"
      : "text-amber-600";

  /* ═══════════════════════════════════════════
     Render
     ═══════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-amber-50/60 text-gray-800 font-sans">
      {/* Header */}
      <header className="bg-gradient-to-r from-amber-600 to-orange-500 text-white px-4 py-4 shadow-md">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <span className="text-3xl">🐱</span>
          <div>
            <h1 className="text-lg font-bold leading-tight">
              くぅのキャットフード研究室
            </h1>
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
                type="number"
                step="0.01"
                min="0"
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
                <p className="text-[11px] text-gray-500">必要カロリー (DER)</p>
                <p className="text-xl font-bold text-amber-700">
                  {fmt(der)}{" "}
                  <span className="text-sm font-normal">kcal</span>
                </p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <p className="text-[11px] text-gray-500">必要水分量</p>
                <p className="text-xl font-bold text-blue-600">
                  {fmt(waterNeed)}{" "}
                  <span className="text-sm font-normal">ml</span>
                </p>
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
              onClick={() => {
                setShowAdd(true);
                setAddMode(foodMaster.length > 0 ? "select" : "new");
              }}
              className="bg-amber-600 hover:bg-amber-700 text-white text-sm px-4 py-1.5 rounded-lg transition"
            >
              + 商品を追加
            </button>
          </div>

          {menuItems.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-6">
              まだ商品が追加されていません
            </p>
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
                    <th className="px-1 py-1.5">kcal/g</th>
                    <th className="px-1 py-1.5">給餌量g</th>
                    <th className="px-1 py-1.5">kcal</th>
                    <th className="px-1 py-1.5">水分ml</th>
                    <th className="px-1 py-1.5 rounded-tr-lg"></th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((e) => (
                    <tr key={e.id} className="border-b border-gray-100 hover:bg-amber-50/40">
                      <td className="px-2 py-1.5 font-medium max-w-[120px] truncate">
                        {e.food.name}
                      </td>
                      <td className="text-center px-1 text-gray-500">
                        {fmt(e.carb)}
                      </td>
                      <td className="text-center px-1">{fmt(e.food.protein)}</td>
                      <td className="text-center px-1">{fmt(e.food.fat)}</td>
                      <td className="text-center px-1">{fmt(e.food.fiber)}</td>
                      <td className="text-center px-1">{fmt(e.food.ash)}</td>
                      <td className="text-center px-1">{fmt(e.food.moisture)}</td>
                      <td className="text-center px-1">{fmt(e.food.kcalPerG)}</td>
                      <td className="text-center px-1">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          className="w-16 border border-gray-200 rounded px-1.5 py-0.5 text-center focus:ring-1 focus:ring-amber-400 focus:outline-none"
                          value={e.amount || ""}
                          onChange={(ev) => updateAmount(e.id, ev.target.value)}
                        />
                      </td>
                      <td className="text-center px-1 font-medium">
                        {fmt(e.totalKcal)}
                      </td>
                      <td className="text-center px-1">{fmt(e.waterMl)}</td>
                      <td className="text-center px-1">
                        <button
                          onClick={() => removeItem(e.id)}
                          className="text-red-400 hover:text-red-600 text-lg leading-none"
                          title="削除"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}

                  {/* Totals row */}
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
        </section>

        {/* ── Summary ── */}
        {w > 0 && menuItems.length > 0 && (
          <section className="bg-white rounded-xl shadow p-4 space-y-3">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
              <span>📊</span> サマリー
            </h2>

            <div className="grid grid-cols-2 gap-3">
              {/* Calorie comparison */}
              <div className="rounded-lg border p-3 space-y-1">
                <p className="text-xs text-gray-500">カロリー</p>
                <p className="text-lg font-bold">
                  {fmt(totals.kcal)}{" "}
                  <span className="text-sm font-normal text-gray-400">
                    / {fmt(der)} kcal
                  </span>
                </p>
                <p className={`text-sm font-semibold ${kcalStatus}`}>
                  {kcalDiff >= 0
                    ? `+${fmt(kcalDiff)} kcal (超過)`
                    : `${fmt(kcalDiff)} kcal (不足)`}
                </p>
                {/* bar */}
                <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      Math.abs(kcalDiff) <= der * 0.05
                        ? "bg-emerald-500"
                        : kcalDiff < 0
                        ? "bg-amber-400"
                        : "bg-red-400"
                    }`}
                    style={{ width: `${Math.min((totals.kcal / der) * 100, 100)}%` }}
                  />
                </div>
              </div>

              {/* Water comparison */}
              <div className="rounded-lg border p-3 space-y-1">
                <p className="text-xs text-gray-500">水分</p>
                <p className="text-lg font-bold">
                  {fmt(totals.water)}{" "}
                  <span className="text-sm font-normal text-gray-400">
                    / {fmt(waterNeed)} ml
                  </span>
                </p>
                <p className={`text-sm font-semibold ${waterStatus}`}>
                  {waterDiff >= 0
                    ? `十分 (+${fmt(waterDiff)} ml)`
                    : `あと ${fmt(Math.abs(waterDiff))} ml 必要`}
                </p>
                <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      waterDiff >= 0 ? "bg-emerald-500" : "bg-amber-400"
                    }`}
                    style={{
                      width: `${Math.min((totals.water / waterNeed) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── DM ── */}
        {menuItems.length > 0 && dryTotal > 0 && (
          <section className="bg-white rounded-xl shadow p-4 space-y-3">
            <h2 className="font-bold text-amber-700 flex items-center gap-1.5">
              <span>🔬</span> DM (乾物量ベース)
            </h2>
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

        {/* ── Export ── */}
        <div className="flex justify-end gap-2 pb-6">
          <button
            onClick={() =>
              exportCSV(petName, weight, der, waterNeed, menuItems, totals, dm)
            }
            className="text-sm border border-gray-300 hover:bg-gray-100 px-4 py-1.5 rounded-lg transition"
          >
            CSV エクスポート
          </button>
        </div>
      </main>

      {/* ═══════════════════════════════════════════
         Add Dialog
         ═══════════════════════════════════════════ */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}
        >
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg text-amber-700">商品を追加</h3>
                <button
                  onClick={() => setShowAdd(false)}
                  className="text-gray-400 hover:text-gray-600 text-xl"
                >
                  ×
                </button>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                <button
                  onClick={() => setAddMode("select")}
                  className={`flex-1 text-sm py-1.5 rounded-md transition ${
                    addMode === "select"
                      ? "bg-white shadow font-medium"
                      : "text-gray-500"
                  }`}
                >
                  保存済みから選択
                </button>
                <button
                  onClick={() => setAddMode("new")}
                  className={`flex-1 text-sm py-1.5 rounded-md transition ${
                    addMode === "new"
                      ? "bg-white shadow font-medium"
                      : "text-gray-500"
                  }`}
                >
                  新しい商品を登録
                </button>
              </div>

              {addMode === "select" ? (
                /* ─── Select from master ─── */
                <div className="space-y-3">
                  {foodMaster.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-4">
                      保存済みの商品がありません。
                      <br />
                      「新しい商品を登録」から追加してください。
                    </p>
                  ) : (
                    <>
                      <select
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                        value={selectedMasterId}
                        onChange={(e) => setSelectedMasterId(e.target.value)}
                      >
                        <option value="">商品を選んでください</option>
                        {foodMaster.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({f.kcalPerG} kcal/g)
                          </option>
                        ))}
                      </select>

                      {/* Show selected food info */}
                      {selectedMasterId && (() => {
                        const sel = foodMaster.find(f => f.id === selectedMasterId);
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
                        <span className="text-xs text-gray-500">
                          給餌量 (g)
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          placeholder="例: 40"
                          value={addAmount}
                          onChange={(e) => setAddAmount(e.target.value)}
                        />
                      </label>

                      <button
                        onClick={addFromMaster}
                        disabled={!selectedMasterId || !addAmount}
                        className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white py-2 rounded-lg font-medium transition"
                      >
                        追加する
                      </button>
                    </>
                  )}
                </div>
              ) : (
                /* ─── New food form ─── */
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-xs text-gray-500">商品名</span>
                    <input
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                      placeholder="例: ヒルズ I/D 消化ケア"
                      value={newFood.name}
                      onChange={(e) =>
                        setNewFood((p) => ({ ...p, name: e.target.value }))
                      }
                    />
                  </label>

                  <p className="text-xs text-gray-500 font-medium">
                    成分 (すべて%)
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "protein", label: "タンパク質" },
                      { key: "fat", label: "脂質" },
                      { key: "fiber", label: "粗繊維" },
                      { key: "ash", label: "灰分" },
                      { key: "moisture", label: "水分" },
                    ].map(({ key, label }) => (
                      <label key={key} className="block">
                        <span className="text-[11px] text-gray-400">
                          {label} (%)
                        </span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                          value={newFood[key]}
                          onChange={(e) =>
                            setNewFood((p) => ({
                              ...p,
                              [key]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                    <label className="block">
                      <span className="text-[11px] text-gray-400">
                        kcal/g
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                        value={newFood.kcalPerG}
                        onChange={(e) =>
                          setNewFood((p) => ({
                            ...p,
                            kcalPerG: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  {/* Auto carb preview */}
                  {newFood.protein && (
                    <p className="text-xs text-gray-500">
                      糖質(自動):{" "}
                      {fmt(
                        calcCarbs(
                          parseFloat(newFood.protein) || 0,
                          parseFloat(newFood.fat) || 0,
                          parseFloat(newFood.fiber) || 0,
                          parseFloat(newFood.ash) || 0,
                          parseFloat(newFood.moisture) || 0
                        )
                      )}
                      %
                    </p>
                  )}

                  <label className="block">
                    <span className="text-xs text-gray-500">給餌量 (g)</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-400 focus:outline-none"
                      placeholder="例: 40"
                      value={addAmount}
                      onChange={(e) => setAddAmount(e.target.value)}
                    />
                  </label>

                  <button
                    onClick={addNewFood}
                    disabled={!newFood.name || !addAmount}
                    className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white py-2 rounded-lg font-medium transition"
                  >
                    登録して追加する
                  </button>
                </div>
              )}

              {/* ─── Master management ─── */}
              {foodMaster.length > 0 && (
                <details className="pt-2">
                  <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
                    保存済み商品の管理 ({foodMaster.length}件)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {foodMaster.map((f) => (
                      <li
                        key={f.id}
                        className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-1.5"
                      >
                        <span className="truncate">{f.name}</span>
                        <button
                          onClick={() => removeMasterFood(f.id)}
                          className="text-red-400 hover:text-red-600 ml-2 shrink-0"
                        >
                          削除
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
