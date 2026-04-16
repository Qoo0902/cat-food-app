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

function corsHeaders(origin, allowed) {
  if (origin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function todayKey(ip) {
  const d = new Date().toISOString().slice(0, 10);
  return `rate:${ip}:${d}`;
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

    // CORS check
    if (origin !== allowed) {
      return jsonResponse({ error: "Forbidden" }, 403, {});
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

    // ─── AI food search (existing) ───
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, headers);
    }

    // Rate limiting
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limit = parseInt(env.DAILY_LIMIT) || 10;
    const rateKey = todayKey(ip);

    let count = 0;
    try {
      const val = await env.RATE_LIMIT.get(rateKey);
      count = val ? parseInt(val) : 0;
    } catch {}

    if (count >= limit) {
      return jsonResponse({ error: `1日${limit}回の上限に達しました。明日またお試しください。` }, 429, headers);
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

      try {
        await env.RATE_LIMIT.put(rateKey, String(count + 1), { expirationTtl: 86400 });
      } catch {}

      const parsed = JSON.parse(jsonMatch[0]);
      return jsonResponse({ data: parsed, remaining: limit - count - 1 }, 200, headers);
    } catch (err) {
      return jsonResponse({ error: "AI検索中にエラーが発生しました" }, 500, headers);
    }
  },
};
