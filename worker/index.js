const GEMINI_PROMPT = `あなたはキャットフードの成分データベースです。
以下の商品名のキャットフードの保証分析値（成分表）を教えてください。

商品名: __NAME__

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
JSONのみ出力してください。`;

const SCAN_PROMPT = `この画像はキャットフードの成分表（保証分析値・保証成分分析値）です。
以下のJSON形式で数値を抽出してください。
数値が見つからない項目は 0 にしてください。商品名も読み取れれば入れてください。
カロリーは「○○gあたり○○kcal」の形で読み取り、kcalGramsとkcalValueに入れてください。
キャットフードの成分表以外の画像だった場合は {"error":"not_food_label"} のみ返してください。
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
JSONのみ出力してください。`;

function corsHeaders(origin, allowed) {
  if (origin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function todayKey(ip, kind = "") {
  const d = new Date().toISOString().slice(0, 10);
  return kind ? `rate:${kind}:${ip}:${d}` : `rate:${ip}:${d}`;
}

function globalTodayKey() {
  const d = new Date().toISOString().slice(0, 10);
  return `rate:global:${d}`;
}

// 無料枠（1日1500req）超過で課金が発生するのを防ぐ安全弁
const GLOBAL_DAILY_LIMIT = 1400;

/* ═══════════════════════════════════════════
   Stripe helpers
   ═══════════════════════════════════════════ */
// 買い切り用ライセンスコード生成（CATFOOD-XXXXXX）
function generateLicenseCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `CATFOOD-${s}`;
}

// Stripe Webhook署名検証（HMAC-SHA256）
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return null;
  const parts = sigHeader.split(",").reduce((m, p) => {
    const [k, v] = p.split("=");
    m[k] = v;
    return m;
  }, {});
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return null;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex !== v1) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

// Stripe API 呼び出しヘルパー
async function stripeFetch(env, path, params) {
  const formData = new URLSearchParams();
  function flatten(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key);
      else if (Array.isArray(v)) v.forEach((item, i) => {
        if (typeof item === "object") flatten(item, `${key}[${i}]`);
        else formData.append(`${key}[${i}]`, String(item));
      });
      else if (v !== undefined && v !== null) formData.append(key, String(v));
    }
  }
  if (params) flatten(params);
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });
  return { ok: resp.ok, status: resp.status, data: await resp.json() };
}

/* ───────────────────────────────────────────
   Atomic rate-limit via Durable Object
   ─────────────────────────────────────────── */
async function rateCount(env, key) {
  try {
    const id = env.RATE_COUNTER.idFromName("shared");
    const stub = env.RATE_COUNTER.get(id);
    const resp = await stub.fetch(
      `https://do.local/?action=get&key=${encodeURIComponent(key)}`
    );
    const data = await resp.json();
    return data.count || 0;
  } catch {
    return 0;
  }
}

async function rateIncrIfBelow(env, key, limit) {
  try {
    const id = env.RATE_COUNTER.idFromName("shared");
    const stub = env.RATE_COUNTER.get(id);
    const resp = await stub.fetch(
      `https://do.local/?action=incr_if_below&key=${encodeURIComponent(key)}&limit=${limit}`
    );
    return await resp.json(); // { exceeded, count }
  } catch {
    return { exceeded: false, count: 0 };
  }
}

async function checkGlobalLimit(env) {
  const key = globalTodayKey();
  const count = await rateCount(env, key);
  return { count, exceeded: count >= GLOBAL_DAILY_LIMIT, key };
}

async function incrementGlobalCount(env, currentCount, key) {
  // Atomic increment via DO (currentCount param kept for backward compat, unused)
  await rateIncrIfBelow(env, key, GLOBAL_DAILY_LIMIT);
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN;
    const headers = corsHeaders(origin, allowed);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    // DEBUG: DO counter状態確認用 (secretトークンが必要)
    if (path === "/__debug-rate") {
      const token = url.searchParams.get("t");
      if (token !== "rinchan-debug-2026") {
        return new Response("forbidden", { status: 403 });
      }
      const key = url.searchParams.get("key") || "";
      if (!key) return new Response("key required", { status: 400 });
      const count = await rateCount(env, key);
      return new Response(JSON.stringify({ key, count }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/__debug-incr") {
      const token = url.searchParams.get("t");
      if (token !== "rinchan-debug-2026") {
        return new Response("forbidden", { status: 403 });
      }
      const key = url.searchParams.get("key") || "";
      const limit = parseInt(url.searchParams.get("limit") || "5");
      if (!key) return new Response("key required", { status: 400 });
      const result = await rateIncrIfBelow(env, key, limit);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/__debug-list") {
      const token = url.searchParams.get("t");
      if (token !== "rinchan-debug-2026") {
        return new Response("forbidden", { status: 403 });
      }
      const prefix = url.searchParams.get("prefix") || "";
      try {
        const id = env.RATE_COUNTER.idFromName("shared");
        const stub = env.RATE_COUNTER.get(id);
        const resp = await stub.fetch(
          `https://do.local/?action=list&prefix=${encodeURIComponent(prefix)}`
        );
        return new Response(await resp.text(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
      }
    }

    // ─── Rate-limit status (read-only, IP-based, CORS open) ───
    // GET /rate-status → { scan: { remaining, limit }, search: { remaining, limit } }
    // 読み取り専用・副作用なし・IPベースなので全Origin許可（CORSチェック前に置く）
    if (path === "/rate-status" && request.method === "GET") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const SCAN_LIMIT = 5;
      const SEARCH_LIMIT = 5;
      const scanCount = await rateCount(env, todayKey(ip, "scan"));
      const searchCount = await rateCount(env, todayKey(ip, "search"));
      return new Response(JSON.stringify({
        scan: { remaining: Math.max(0, SCAN_LIMIT - scanCount), limit: SCAN_LIMIT },
        search: { remaining: Math.max(0, SEARCH_LIMIT - searchCount), limit: SEARCH_LIMIT },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // CORS check
    if (origin !== allowed) {
      return jsonResponse({ error: "Forbidden" }, 403, {});
    }

    // ─── Stripe: Create Checkout Session ───
    // POST /create-checkout-session { origin? }
    // → { url: "https://checkout.stripe.com/..." }
    if (path === "/create-checkout-session" && request.method === "POST") {
      try {
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
          return jsonResponse({ error: "Stripe未設定" }, 500, headers);
        }
        let body = {};
        try { body = await request.json(); } catch {}
        const appOrigin = allowed; // https://qoo0902.github.io
        const successUrl = `${appOrigin}/cat-food-app/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${appOrigin}/cat-food-app/?checkout=cancel`;

        const res = await stripeFetch(env, "/checkout/sessions", {
          mode: "payment",
          "line_items[0][price]": env.STRIPE_PRICE_ID,
          "line_items[0][quantity]": "1",
          success_url: successUrl,
          cancel_url: cancelUrl,
          customer_creation: "always",
          "payment_intent_data[metadata][app]": "cat-food-app",
          "metadata[app]": "cat-food-app",
          allow_promotion_codes: "true",
        });
        if (!res.ok) {
          return jsonResponse({ error: res.data?.error?.message || "Checkout作成失敗" }, 502, headers);
        }
        return jsonResponse({ url: res.data.url, sessionId: res.data.id }, 200, headers);
      } catch (err) {
        return jsonResponse({ error: "Checkout処理エラー" }, 500, headers);
      }
    }

    // ─── Stripe: Webhook receiver ───
    // checkout.session.completed でライセンスコード自動発行
    if (path === "/stripe-webhook" && request.method === "POST") {
      try {
        if (!env.STRIPE_WEBHOOK_SECRET) {
          return jsonResponse({ error: "Webhook secret 未設定" }, 500, {});
        }
        const sig = request.headers.get("stripe-signature");
        const rawBody = await request.text();
        const event = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
        if (!event) {
          return jsonResponse({ error: "Invalid signature" }, 400, {});
        }

        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const sessionId = session.id;

          // すでに発行済み（重複受信対策）
          const existing = await env.RATE_LIMIT.get(`session:${sessionId}`);
          if (existing) {
            return jsonResponse({ received: true, code: existing, duplicate: true }, 200, {});
          }

          // ランダムコード生成（衝突対策で最大5回リトライ）
          let code = null;
          for (let i = 0; i < 5; i++) {
            const candidate = generateLicenseCode();
            const exists = await env.RATE_LIMIT.get(`license:${candidate}`);
            if (!exists) { code = candidate; break; }
          }
          if (!code) {
            return jsonResponse({ error: "コード生成失敗" }, 500, {});
          }

          const lic = {
            type: "paid",
            email: session.customer_details?.email || session.customer_email || null,
            customerId: session.customer || null,
            stripeSessionId: sessionId,
            devices: [],
            expiresAt: null, // 無期限
            purchasedAt: new Date().toISOString(),
            amountTotal: session.amount_total,
            currency: session.currency,
          };
          await env.RATE_LIMIT.put(`license:${code}`, JSON.stringify(lic), { expirationTtl: 10 * 365 * 86400 });
          await env.RATE_LIMIT.put(`session:${sessionId}`, code, { expirationTtl: 30 * 86400 });
        }

        return jsonResponse({ received: true }, 200, {});
      } catch (err) {
        return jsonResponse({ error: "Webhook処理エラー" }, 500, {});
      }
    }

    // ─── License: Get code by Stripe session ID（決済成功後の初期表示用） ───
    // POST /get-license-by-session { sessionId }
    // → { code: "CATFOOD-XXXXXX" } or { error }
    if (path === "/get-license-by-session" && request.method === "POST") {
      try {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400, headers); }
        const sessionId = String(body.sessionId || "").trim();
        if (!sessionId) return jsonResponse({ error: "sessionIdが必要です" }, 400, headers);
        // 署名検証：Stripe APIでセッションが本物か確認
        if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: "未設定" }, 500, headers);
        const verify = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        if (!verify.ok) return jsonResponse({ error: "セッション検証失敗" }, 404, headers);
        const sessionData = await verify.json();
        if (sessionData.payment_status !== "paid") {
          return jsonResponse({ error: "支払い未完了です" }, 403, headers);
        }

        // コード取得（Webhook処理後にKVに入る）
        const code = await env.RATE_LIMIT.get(`session:${sessionId}`);
        if (!code) {
          return jsonResponse({ error: "コード発行処理中です。数秒後にもう一度お試しください。" }, 202, headers);
        }
        return jsonResponse({ code, email: sessionData.customer_details?.email }, 200, headers);
      } catch (err) {
        return jsonResponse({ error: "取得処理エラー" }, 500, headers);
      }
    }

    // ─── License: Verify access code ───
    // POST /verify-code { code, deviceId }
    // レスポンス: {ok:true, type:"member"|"paid", expiresAt:"..."} or {ok:false, reason:"..."}
    if (path === "/verify-code" && request.method === "POST") {
      try {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ ok:false, reason:"invalid_json" }, 400, headers); }
        const code = String(body.code || "").trim().toUpperCase();
        const deviceId = String(body.deviceId || "").trim();
        const MAX_DEVICES = 3;

        if (!code || code.length < 4) return jsonResponse({ ok:false, reason:"コードが短すぎます" }, 400, headers);
        if (!deviceId) return jsonResponse({ ok:false, reason:"デバイスIDが必要です" }, 400, headers);

        const raw = await env.RATE_LIMIT.get(`license:${code}`);
        if (!raw) return jsonResponse({ ok:false, reason:"このコードは無効です" }, 404, headers);

        let lic;
        try { lic = JSON.parse(raw); } catch { return jsonResponse({ ok:false, reason:"ライセンス情報が壊れています" }, 500, headers); }

        // 期限チェック
        if (lic.expiresAt) {
          const now = new Date();
          const exp = new Date(lic.expiresAt);
          if (now > exp) return jsonResponse({ ok:false, reason:"このコードは有効期限が切れています" }, 403, headers);
        }

        // デバイス登録チェック
        // - type="member": 全体配布コードなのでデバイス無制限（拡散対策は月次更新で担保）
        // - type="paid": 個別購入コードなので3台まで
        lic.devices = Array.isArray(lic.devices) ? lic.devices : [];
        const deviceLimitApplies = lic.type !== "member";

        if (!lic.devices.includes(deviceId)) {
          if (deviceLimitApplies && lic.devices.length >= MAX_DEVICES) {
            return jsonResponse({ ok:false, reason:`このコードはすでに${MAX_DEVICES}台で使用中です` }, 403, headers);
          }
          // memberはデバイスリストを記録するが上限はチェックしない（統計用）
          // devicesリストが肥大化しないよう、memberは先頭1000件まで保持
          lic.devices.push(deviceId);
          if (lic.type === "member" && lic.devices.length > 1000) {
            lic.devices = lic.devices.slice(-1000);
          }
          await env.RATE_LIMIT.put(`license:${code}`, JSON.stringify(lic), { expirationTtl: 365 * 86400 });
        }

        return jsonResponse({
          ok: true,
          type: lic.type || "member",
          expiresAt: lic.expiresAt || null,
          devicesUsed: lic.devices.length,
          maxDevices: deviceLimitApplies ? MAX_DEVICES : null,
        }, 200, headers);
      } catch (err) {
        return jsonResponse({ ok:false, reason:"認証処理でエラーが発生しました" }, 500, headers);
      }
    }

    // ─── Backup: Save data ───
    if (path === "/backup" && request.method === "POST") {
      try {
        const body = await request.json();
        const code = (body.code || "").trim();
        if (!code || code.length < 4) return jsonResponse({ error: "復元コードが無効です" }, 400, headers);
        const data = body.data;
        if (!data) return jsonResponse({ error: "データがありません" }, 400, headers);
        // Store with 1 year expiry
        await env.RATE_LIMIT.put(`backup:${code}`, JSON.stringify(data), { expirationTtl: 365 * 86400 });
        return jsonResponse({ ok: true }, 200, headers);
      } catch (err) {
        return jsonResponse({ error: "バックアップ保存に失敗しました" }, 500, headers);
      }
    }

    // ─── Backup: Restore data ───
    if (path === "/restore" && request.method === "POST") {
      try {
        const body = await request.json();
        const code = (body.code || "").trim();
        if (!code) return jsonResponse({ error: "復元コードを入力してください" }, 400, headers);
        const raw = await env.RATE_LIMIT.get(`backup:${code}`);
        if (!raw) return jsonResponse({ error: "この復元コードのデータが見つかりません" }, 404, headers);
        return jsonResponse({ data: JSON.parse(raw) }, 200, headers);
      } catch (err) {
        return jsonResponse({ error: "復元に失敗しました" }, 500, headers);
      }
    }

    // ─── Scan food label image (Gemini Vision) ───
    if (path === "/scan-label" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const limit = 5; // 撮影は1日5回/IP
      const rateKey = todayKey(ip, "scan");

      // グローバル上限（無料枠超過防止の安全弁）— 事前チェック
      const globalKey = globalTodayKey();
      const globalCount = await rateCount(env, globalKey);
      if (globalCount >= GLOBAL_DAILY_LIMIT) {
        return jsonResponse({ error: "本日のAI機能は全体の上限に達しました。明日またお試しください。" }, 429, headers);
      }

      // 事前チェック（Geminiを呼ぶ前に早期429するため）
      const preCount = await rateCount(env, rateKey);
      if (preCount >= limit) {
        return jsonResponse({ error: `成分表撮影は1日${limit}回の上限に達しました。明日またお試しください。` }, 429, headers);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400, headers);
      }

      const imageBase64 = (body.image || "").trim();
      const mimeType = (body.mimeType || "image/jpeg").trim();
      if (!imageBase64) {
        return jsonResponse({ error: "画像データが必要です" }, 400, headers);
      }
      // サイズ制限：base64で約10MB（画像実体 ~7MB）まで
      if (imageBase64.length > 10 * 1024 * 1024) {
        return jsonResponse({ error: "画像サイズが大きすぎます" }, 413, headers);
      }

      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return jsonResponse({ error: "Server configuration error" }, 500, headers);
      }

      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: SCAN_PROMPT },
                  { inlineData: { mimeType, data: imageBase64 } },
                ],
              }],
              generationConfig: { temperature: 0.1 },
            }),
          }
        );

        if (!resp.ok) {
          return jsonResponse({ error: "画像解析に失敗しました" }, 502, headers);
        }

        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
          return jsonResponse({ error: "成分情報を取得できませんでした" }, 404, headers);
        }

        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return jsonResponse({ error: "AIの応答を解析できませんでした" }, 502, headers);
        }

        if (parsed && parsed.error === "not_food_label") {
          return jsonResponse({ error: "キャットフードの成分表が検出できませんでした" }, 422, headers);
        }

        // 原子的にレート制限カウンタをインクリメント（競合を正しく検知）
        const scanIncr = await rateIncrIfBelow(env, rateKey, limit);
        if (scanIncr.exceeded) {
          return jsonResponse({ error: `成分表撮影は1日${limit}回の上限に達しました。明日またお試しください。` }, 429, headers);
        }
        // グローバルカウントも原子的に加算
        await rateIncrIfBelow(env, globalKey, GLOBAL_DAILY_LIMIT);

        return jsonResponse({ data: parsed, remaining: limit - scanIncr.count }, 200, headers);
      } catch (err) {
        return jsonResponse({ error: "画像解析中にエラーが発生しました" }, 500, headers);
      }
    }

    // ─── AI food search (existing) ───
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, headers);
    }

    // Rate limiting
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limit = 5; // AI自動入力は1日5回/IP
    const rateKey = todayKey(ip, "search");
    const globalKey = globalTodayKey();

    // グローバル上限（無料枠超過防止の安全弁）— 事前チェック
    const globalCount = await rateCount(env, globalKey);
    if (globalCount >= GLOBAL_DAILY_LIMIT) {
      return jsonResponse({ error: "本日のAI機能は全体の上限に達しました。明日またお試しください。" }, 429, headers);
    }

    // 事前チェック（Geminiを呼ぶ前に早期429するため）
    const preCount = await rateCount(env, rateKey);
    if (preCount >= limit) {
      return jsonResponse({ error: `AI自動入力は1日${limit}回の上限に達しました。明日またお試しください。` }, 429, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400, headers);
    }

    const productName = (body.name || "").trim();
    if (!productName) {
      return jsonResponse({ error: "商品名が必要です" }, 400, headers);
    }

    const geminiKey = env.GEMINI_API_KEY;
    if (!geminiKey) {
      return jsonResponse({ error: "Server configuration error" }, 500, headers);
    }

    try {
      const prompt = GEMINI_PROMPT.replace("__NAME__", productName);
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 },
            tools: [{ googleSearch: {} }],
          }),
        }
      );

      if (!resp.ok) {
        return jsonResponse({ error: "AI検索に失敗しました" }, 502, headers);
      }

      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        return jsonResponse({ error: "成分情報を取得できませんでした" }, 404, headers);
      }

      // 原子的にレート制限カウンタをインクリメント（競合を正しく検知）
      const searchIncr = await rateIncrIfBelow(env, rateKey, limit);
      if (searchIncr.exceeded) {
        return jsonResponse({ error: `AI自動入力は1日${limit}回の上限に達しました。明日またお試しください。` }, 429, headers);
      }
      // グローバルカウントも原子的に加算
      await rateIncrIfBelow(env, globalKey, GLOBAL_DAILY_LIMIT);

      const parsed = JSON.parse(jsonMatch[0]);
      return jsonResponse({ data: parsed, remaining: limit - searchIncr.count }, 200, headers);
    } catch (err) {
      return jsonResponse({ error: "AI検索中にエラーが発生しました" }, 500, headers);
    }
  },
};

/* ═══════════════════════════════════════════
   Durable Object: atomic rate-limit counter
   ─ Single-threaded execution guarantees atomicity.
   ─ All counters share one DO instance (idFromName("shared")).
   ─ Daily keys (rate:kind:ip:YYYY-MM-DD) never clash across days.
   ═══════════════════════════════════════════ */
export class RateLimitCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const key = url.searchParams.get("key") || "";

    if (action === "get" || action === "incr_if_below") {
      if (!key) {
        return new Response(JSON.stringify({ error: "key required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (action === "get") {
      const count = (await this.state.storage.get(key)) || 0;
      return new Response(JSON.stringify({ count }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (action === "incr_if_below") {
      const limit = parseInt(url.searchParams.get("limit") || "5");
      const current = (await this.state.storage.get(key)) || 0;
      if (current >= limit) {
        return new Response(JSON.stringify({ exceeded: true, count: current }), {
          headers: { "content-type": "application/json" },
        });
      }
      const next = current + 1;
      await this.state.storage.put(key, next);
      return new Response(JSON.stringify({ exceeded: false, count: next }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (action === "list") {
      const prefix = url.searchParams.get("prefix") || "";
      const all = await this.state.storage.list();
      const result = [];
      for (const [k, v] of all) {
        if (!prefix || k.startsWith(prefix)) result.push({ key: k, value: v });
      }
      return new Response(JSON.stringify({ items: result }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (action === "cleanup") {
      // Optional manual cleanup: remove all keys older than 2 days
      const today = new Date().toISOString().slice(0, 10);
      const all = await this.state.storage.list();
      let removed = 0;
      for (const k of all.keys()) {
        // Keys end with :YYYY-MM-DD, remove if older than today-1
        const m = k.match(/:(\d{4}-\d{2}-\d{2})$/);
        if (m && m[1] < today) {
          await this.state.storage.delete(k);
          removed++;
        }
      }
      return new Response(JSON.stringify({ removed }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
}
