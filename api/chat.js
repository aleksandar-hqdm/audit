// Audit Assistant agent (Vercel serverless function).
// Claude Sonnet + retrieval over the report/data knowledge index + a live DataForSEO tool,
// with a per-session budget and a global daily kill-switch. Secrets come from env vars only.
const fs = require("fs");
const path = require("path");

const MODEL = process.env.CHAT_MODEL || "claude-sonnet-4-6";
const PRICE_IN = (+(process.env.PRICE_IN_PER_MTOK || 3)) / 1e6;     // $ per input token
const PRICE_OUT = (+(process.env.PRICE_OUT_PER_MTOK || 15)) / 1e6;  // $ per output token
const PRICE_CACHE_READ = PRICE_IN * 0.1;
const PRICE_CACHE_WRITE = PRICE_IN * 1.25;
const DFS_COST = +(process.env.DFS_COST || 0.003);                 // est. $ per DataForSEO call
const SESSION_CAP = +(process.env.SESSION_CAP || 0.10);            // $ per conversation
const DAILY_CAP = +(process.env.DAILY_CAP || 0.50);               // $ per day (global kill-switch)
const MAX_OUT = +(process.env.MAX_OUT_TOKENS || 700);
const MAX_TOOLCALLS = 3;

const SYS_PROMPT =
  "You are the Audit Assistant for a competitive SEO recovery audit of Mentalyc (an AI therapy-notes SaaS), " +
  "prepared by Aleksandar Ackovski / Growth Radical. Answer questions about THIS project using only the PROJECT KNOWLEDGE " +
  "provided below and the dataforseo_serp tool. Be accurate, concise and plain-spoken; lead with the answer. " +
  "Cite specific numbers from the knowledge when relevant, and point the reader to the right report tab by name " +
  "(for example 'see the Backlinks tab'). If the knowledge does not cover something, say so plainly rather than guessing. " +
  "Use the dataforseo_serp tool only when the user asks about CURRENT/live rankings that the report would not already contain, " +
  "and keep it to what is needed. Never invent figures. Do not use the em dash character. Keep answers under about 180 words unless asked for more.";

let KB = null;
function kb() {
  if (!KB) { try { KB = JSON.parse(fs.readFileSync(path.join(__dirname, "knowledge.json"), "utf8")); } catch (e) { KB = []; } }
  return KB;
}
function retrieve(query, k) {
  const words = (String(query || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter(function (w) { return w.length > 2; });
  if (!words.length) return kb().slice(0, 3);
  const scored = kb().map(function (c) {
    const title = (c.title || "").toLowerCase(), text = (c.text || "").toLowerCase();
    let s = 0; words.forEach(function (w) { if (title.indexOf(w) >= 0) s += 3; if (text.indexOf(w) >= 0) s += 1; });
    return { c: c, s: s };
  }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, k || 6);
  return scored.map(function (x) { return x.c; });
}

// ---- Upstash Redis REST (optional; required for the global daily cap) ----
async function kvCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
    const d = await r.json(); return d && ("result" in d) ? d.result : null;
  } catch (e) { return null; }
}
async function dailyGet(key) { const v = await kvCmd(["GET", key]); return v == null ? null : +v; }
async function dailyAdd(key, by) { const v = await kvCmd(["INCRBYFLOAT", key, by]); await kvCmd(["EXPIRE", key, 172800]); return v == null ? null : +v; }

// ---- DataForSEO live SERP tool ----
async function dfsSerp(keyword) {
  const login = process.env.DATAFORSEO_LOGIN, pw = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pw) return "DataForSEO is not configured on the server.";
  const auth = Buffer.from(login + ":" + pw).toString("base64");
  const r = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST", headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword: String(keyword).slice(0, 120), location_code: 2840, language_code: "en", depth: 10 }])
  });
  const d = await r.json();
  const items = (((d.tasks || [])[0] || {}).result || [])[0] || {};
  const out = []; let aio = false; let mention = null;
  (items.items || []).forEach(function (it) {
    if (it.type === "ai_overview") aio = true;
    if (it.type === "organic" && out.length < 8) {
      out.push("#" + it.rank_group + " " + (it.domain || ""));
      if (/mentalyc/.test(it.domain || "")) mention = it.rank_group;
    }
  });
  return "Live US Google SERP for \"" + keyword + "\": " + (out.join(", ") || "no organic results parsed") +
    ". AI Overview present: " + (aio ? "yes" : "no") + ". Mentalyc: " + (mention ? "#" + mention : "not in top 10") + ".";
}
const TOOLS = [{
  name: "dataforseo_serp",
  description: "Look up the LIVE Google US organic search results for a keyword: returns the top ranked domains and positions, whether an AI Overview is present, and Mentalyc's position. Use only for current rankings not already in the report.",
  input_schema: { type: "object", properties: { keyword: { type: "string", description: "the search query" } }, required: ["keyword"] }
}];

async function anthropic(system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUT, system: system, tools: TOOLS, messages: messages })
  });
  return r.json();
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.json({ error: "POST only" }); }
  if (!process.env.ANTHROPIC_API_KEY) { res.statusCode = 500; return res.json({ reply: "The assistant is not configured yet (missing ANTHROPIC_API_KEY).", spent: 0 }); }

  let body = ""; await new Promise(function (ok) { req.on("data", function (c) { body += c; }); req.on("end", ok); });
  let payload = {}; try { payload = JSON.parse(body || "{}"); } catch (e) { }
  const incoming = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  let sessionSpent = Math.max(0, +payload.spent || 0);
  const msgs = incoming.filter(function (m) { return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, 4000) }; });
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") { return res.json({ reply: "Ask me a question about the audit.", spent: sessionSpent }); }

  if (sessionSpent >= SESSION_CAP) {
    return res.json({ reply: "You have reached this chat's spending limit of $" + SESSION_CAP.toFixed(2) + ". Refresh the page to start a new conversation.", spent: sessionSpent, capped: "session" });
  }
  const dayKey = "audit:spend:" + new Date().toISOString().slice(0, 10);
  const daily = await dailyGet(dayKey);
  if (daily != null && daily >= DAILY_CAP) {
    return res.json({ reply: "The assistant has reached today's overall usage limit. Please try again tomorrow.", spent: sessionSpent, capped: "daily" });
  }

  const lastUser = msgs[msgs.length - 1].content;
  const ctx = retrieve(lastUser, 6).map(function (c) { return "[" + c.tab + "] " + c.title + "\n" + c.text; }).join("\n\n---\n\n");
  const system = [
    { type: "text", text: SYS_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: "PROJECT KNOWLEDGE (retrieved for this question):\n\n" + ctx }
  ];

  let convo = msgs.slice(), cost = 0, dfsCalls = 0, finalText = "";
  try {
    for (let i = 0; i <= MAX_TOOLCALLS; i++) {
      const resp = await anthropic(system, convo);
      if (resp.error) { return res.json({ reply: "The assistant hit an error. Please try again in a moment.", spent: sessionSpent, error: String(resp.error.message || resp.error).slice(0, 200) }); }
      const u = resp.usage || {};
      cost += (u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT +
        (u.cache_read_input_tokens || 0) * PRICE_CACHE_READ + (u.cache_creation_input_tokens || 0) * PRICE_CACHE_WRITE;
      const blocks = resp.content || [];
      const txt = blocks.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
      if (txt) finalText = txt;
      const toolUses = blocks.filter(function (b) { return b.type === "tool_use"; });
      if (resp.stop_reason !== "tool_use" || !toolUses.length || dfsCalls >= MAX_TOOLCALLS || (sessionSpent + cost) >= SESSION_CAP) break;
      convo.push({ role: "assistant", content: blocks });
      const results = [];
      for (const tu of toolUses) {
        let out = "Tool unavailable.";
        if (tu.name === "dataforseo_serp") { try { out = await dfsSerp((tu.input || {}).keyword || ""); dfsCalls++; cost += DFS_COST; } catch (e) { out = "Live lookup failed."; } }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      convo.push({ role: "user", content: results });
    }
  } catch (e) {
    return res.json({ reply: "The assistant hit an error. Please try again.", spent: sessionSpent });
  }

  sessionSpent += cost;
  await dailyAdd(dayKey, +cost.toFixed(5));
  if (!finalText) finalText = "I could not generate an answer for that. Try rephrasing, or ask about the diagnosis, the code-cluster opportunity, competitors, AI visibility, links, PR or the roadmap.";
  return res.json({ reply: finalText, spent: +sessionSpent.toFixed(4) });
};
