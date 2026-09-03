/* SHUNDEN 英語体力測定 — 採点API（Netlify Function）
   必要な環境変数: ANTHROPIC_API_KEY
   任意の環境変数: SCORE_MODEL（既定 claude-sonnet-5） */

const FALLBACK_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];
const clip = (s, n) => String(s || "").slice(0, n);

function modelCandidates() {
  const preferred = process.env.SCORE_MODEL;
  const list = preferred ? [preferred] : [];
  FALLBACK_MODELS.forEach((m) => { if (!list.includes(m)) list.push(m); });
  return list;
}

function buildPrompt(data) {
  const isText = data.mode === "text";
  const payload = {
    測定モード: isText ? "タイピング（音声なし）" : "音声",
    音読: (data.reading || []).slice(0, 5).map((r) => ({
      課題文: clip(r.target, 200),
      認識結果: clip(r.transcript, 400),
      単語一致率: (r.matchPct ?? 0) + "%",
      WPM: r.wpm ?? 0,
    })),
    瞬間作文: (data.comp || []).slice(0, 8).map((c) => ({
      お題_日本語: clip(c.ja, 100),
      回答: clip(c.transcript, 400),
      反応時間秒: Math.round((c.latencyMs || 0) / 100) / 10,
    })),
    スモールトーク: (data.talk || []).slice(0, 8).map((t) => ({
      質問: clip(t.question, 200),
      回答: clip(t.transcript, 600),
    })),
  };
  const modeNote = isText
    ? "今回はタイピングモード（音声なし）です。pronunciation と fluency は必ず -1 にし、total は accuracy / quickness / conversation の3項目から算出してください。"
    : "回答は音声認識の結果です。句読点・大文字小文字・同音異義語の誤認識は減点せず、内容と構造で判断してください。";

  return `日本人向け英語スピーキング診断「SHUNDEN英語体力測定」の採点者として採点してください。ブランド思想は「英語は体育」（勉強ではなく練習・トレーニング）。受験者は英語を使う必要があるのに口から出ずに困っている大人です。

${modeNote}
回答が空の項目は未回答として扱ってください。

測定データ:
${JSON.stringify(payload, null, 2)}

採点（各0〜100の整数）:
- pronunciation 明瞭度: 音読の単語一致率をベースに
- fluency 流暢さ: WPM（80以上で良好、110以上で優秀）と発話の持続性
- accuracy 正確さ: 文法・語彙の正確さ
- quickness 瞬発力: 瞬間作文の反応速度（3秒以内は優秀）と文の完成度
- conversation 対話力: スモールトークの応答の適切さと内容の膨らませ方
- total 総合

level（totalに応じて）: 0-39「準備運動レベル」/ 40-54「基礎トレレベル」/ 55-69「実戦練習レベル」/ 70-84「レギュラー選手レベル」/ 85-100「アスリートレベル」

feedback は瞬間作文とスモールトークの各項目について、自然な英語の言い直し（natural）と日本語コメント（comment、1〜2文、前向きで具体的、「勉強」ではなく「練習」「トレーニング」と表現）。未回答にはお手本の英文と励ましを。

下記JSONのみで出力。前置き・マークダウン記法は不要:
{"scores":{"pronunciation":0,"fluency":0,"accuracy":0,"quickness":0,"conversation":0,"total":0},"level":"","feedback":[{"section":"瞬間作文","prompt":"お題","you":"受験者の回答","natural":"自然な英語","comment":"日本語コメント"}],"advice":"総合アドバイス（日本語2〜3文）"}`;
}

async function callClaude(apiKey, model, prompt, maxTokens) {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const res = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json: json };
}

function extractText(json) {
  const blocks = (json && json.content) || [];
  return blocks.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

function blockSummary(json) {
  const blocks = (json && json.content) || [];
  return blocks.map((b) => (b && b.type) || "?").join(",") || "(none)";
}

function extractJsonObject(text) {
  const clean = String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try { return JSON.parse(clean.slice(first, last + 1)); } catch (e) { return null; }
}

const reply = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status: status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default async (req) => {
  const apiKey = process.env ? process.env.ANTHROPIC_API_KEY : null;
  const models = modelCandidates();

  /* --- 疎通確認モード（GET） --- */
  if (req.method === "GET") {
    if (!apiKey) {
      return reply(200, { ping: "NG", reason: "ANTHROPIC_API_KEY が設定されていません（Netlifyの環境変数を設定 → 再デプロイしてください）" });
    }
    const tried = [];
    for (const m of models) {
      try {
        const r = await callClaude(apiKey, m, "Reply with the single word: OK", 64);
        if (r.ok) {
          const t = extractText(r.json).trim();
          return reply(200, {
            ping: t ? "OK" : "NG",
            model: m,
            sample: t.slice(0, 40),
            blocks: blockSummary(r.json),
            stop_reason: r.json && r.json.stop_reason,
            reason: t ? undefined : "モデルからテキストが返りませんでした",
            tried: tried,
          });
        }
        tried.push({ model: m, status: r.status, error: (r.json && r.json.error && r.json.error.message) || "unknown" });
      } catch (e) {
        tried.push({ model: m, status: 0, error: String(e && e.message) });
      }
    }
    return reply(200, { ping: "NG", reason: "APIに接続できませんでした", tried: tried });
  }

  if (req.method !== "POST") return reply(405, { error: "Method Not Allowed" });
  if (!apiKey) return reply(500, { error: "ANTHROPIC_API_KEY が設定されていません", hint: "Netlifyの環境変数を設定したあと、もう一度デプロイしてください" });

  let data;
  try { data = JSON.parse((await req.text()) || "{}"); }
  catch (e) { return reply(400, { error: "リクエストの形式が不正です" }); }

  const prompt = buildPrompt(data);
  const tried = [];

  for (const model of models) {
    let r;
    try {
      r = await callClaude(apiKey, model, prompt, 4000);
    } catch (e) {
      tried.push({ model: model, status: 0, error: "通信エラー: " + String(e && e.message) });
      continue;
    }
    if (!r.ok) {
      const em = (r.json && r.json.error && r.json.error.message) || ("HTTP " + r.status);
      tried.push({ model: model, status: r.status, error: em });
      // 404（モデル名不正）は次の候補へ。それ以外は即返す
      if (r.status === 404) continue;
      return reply(502, { error: "採点APIがエラーを返しました", detail: em, status: r.status, tried: tried });
    }
    const text = extractText(r.json);
    const parsed = extractJsonObject(text);
    if (parsed && parsed.scores) return reply(200, parsed);
    return reply(502, {
      error: "採点結果の読み取りに失敗しました",
      detail: clip(text, 300) || "(モデルからテキストが返りませんでした)",
      model: model,
      blocks: blockSummary(r.json),
      stop_reason: r.json && r.json.stop_reason,
      usage: r.json && r.json.usage,
    });
  }

  return reply(502, { error: "利用できるモデルが見つかりませんでした", tried: tried });
};
