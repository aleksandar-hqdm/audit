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
  "You are the Audit Assistant for a competitive SEO recovery audit of Mentalyc (an AI therapy-notes SaaS), prepared by " +
  "Aleksandar Ackovski at Growth Radical. Think of yourself as a sharp, friendly SEO strategist on the team: you know this " +
  "audit cold and you explain it like a helpful colleague, not a search box.\n\n" +
  "How to answer:\n" +
  "- Give a real, direct answer FIRST, in one or two plain sentences. Then add the specifics (numbers, named competitors, " +
  "examples) that back it up. Never reply with just 'see the X tab' or a deflection.\n" +
  "- Ground everything in the CORE PROJECT FACTS and the retrieved detail below, and in the dataforseo_serp tool for current " +
  "rankings. You may connect and synthesize ideas across the material to give a fuller answer, but never invent a specific " +
  "number, name, date or claim that is not supported.\n" +
  "- You can and should answer questions ABOUT the report itself (who made it, when, how, what data and methodology, scope, " +
  "how thorough it was). That information is in the CORE PROJECT FACTS.\n" +
  "- If something genuinely is not covered, say so briefly and friendly, then offer what you CAN help with. Do not stonewall.\n" +
  "- Where it helps, point the reader to the relevant report tab by name (for example 'the Backlinks tab').\n" +
  "- Use dataforseo_serp only for live/current rankings the report would not already contain.\n\n" +
  "Your readers: Mentalyc's small founding team, not a marketing department. Mentalyc is an Entrepreneur First startup in " +
  "San Francisco, founded by Maria Szandrach (CEO, business and growth) and Georgi Urumov (co-founder, engineering and data), " +
  "maybe with one marketing or content person. So expect sharp, busy, informal questions, sometimes blunt or existential " +
  "(for example 'are we cooked?', 'whats the one thing', 'is it worth it'), sometimes very tactical (for example 'what do I " +
  "build first', 'how much dev work', 'who do I hire'), and often loosely worded with typos, slang or fragments. ALWAYS read " +
  "the intent generously and answer the real question. Never nitpick phrasing or ask them to rephrase unless it is genuinely " +
  "impossible to tell what they mean (then give your best guess and offer a quick clarification). For existential or ROI " +
  "questions be honest but encouraging where the data supports it; for build questions get concrete.\n\n" +
  "Voice: warm, confident, plain-spoken, a little personality is good. Lead with the answer in the first sentence. Keep it " +
  "tight, usually under about 160 words, unless the user asks for depth. Never use the em dash character.";

let KB = null;
function kb() {
  if (!KB) { try { KB = JSON.parse(fs.readFileSync(path.join(__dirname, "knowledge.json"), "utf8")); } catch (e) { KB = []; } }
  return KB;
}
// query expansion so casual phrasing still hits the right material
const EXPAND = {
  beat: "competitors win mechanism", beaten: "competitors win", beating: "competitors win", lose: "beaten competitors",
  losing: "beaten declining", lost: "decline beaten", eat: "competitors win decline", eating: "competitors win",
  cooked: "fixable upside recovery penalty", screwed: "fixable upside recovery", doomed: "fixable upside recovery",
  dead: "fixable upside recovery", trouble: "fixable upside diagnosis", bad: "diagnosis fixable", recover: "fixable upside roadmap",
  recovery: "fixable upside roadmap", recoverable: "fixable upside", fixable: "fixable upside", fix: "fixable roadmap build",
  worth: "upside fixable roi", upside: "fixable opportunity roadmap", roi: "upside fixable opportunity", return: "upside roi",
  revenue: "upside conversion opportunity", money: "upside conversion pricing", traffic: "decline clicks fixable",
  clicks: "ai overview decline", who: "about prepared author audience", author: "about prepared", made: "about prepared methodology",
  make: "about methodology", wrote: "about prepared", created: "about prepared", build_report: "about methodology",
  long: "about methodology timeline roadmap", time: "about methodology timeline", took: "about methodology",
  fast: "timeline roadmap", quick: "timeline roadmap", soon: "timeline roadmap", when: "timeline roadmap", results: "timeline roadmap",
  cost: "pricing conversion cro", price: "pricing cro", pricing: "cro conversion", convert: "conversion cro funnel",
  links: "backlinks referring anchors", link: "backlinks referring", backlink: "backlinks referring anchors",
  toxic: "toxic anchors disavow", anchor: "anchors backlinks toxic", disavow: "toxic anchors", spam: "spam toxic backlinks",
  penalty: "penalty fixable diagnosis", banned: "penalty diagnosis", build: "page blueprints silo programmatic",
  hire: "page blueprints roadmap", dev: "programmatic page blueprints", developer: "programmatic page blueprints",
  programmatic: "code page blueprints", schema: "page blueprints cro", recommend: "ai recommendation cited named",
  cited: "ai recommendation visibility", citation: "ai recommendation visibility", named: "ai recommendation visibility",
  ai: "ai overview visibility recommendation", gemini: "ai visibility recommendation", chatgpt: "ai visibility recommendation",
  perplexity: "ai visibility recommendation", opportunity: "code cluster opportunity roadmap", biggest: "code cluster opportunity",
  priority: "roadmap opportunity build", first: "roadmap opportunity build", threat: "competitors win", competitor: "competitors win",
  rival: "competitors win", twofold: "competitors win", supanote: "competitors win", blueprint: "competitors win codes",
  upheal: "competitors", code: "code cluster icd programmatic", codes: "code cluster icd", icd: "code cluster icd",
  cpt: "code cluster icd", cluster: "code cluster topical", funnel: "funnel tofu mofu bofu", gate: "gating worksheets funnel",
  gated: "gating worksheets", worksheet: "gating funnel", reddit: "community reddit", community: "community reddit",
  reviewer: "clinical reviewer trust", review: "clinical reviewer competitors", trust: "clinical reviewer", brand: "brand awareness pr",
  awareness: "brand pr", pr: "digital pr awareness", press: "digital pr"
};
function expand(words) {
  const out = words.slice();
  words.forEach(function (w) { if (EXPAND[w]) EXPAND[w].split(" ").forEach(function (x) { out.push(x); }); });
  return out;
}
function retrieve(query, k) {
  let words = (String(query || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter(function (w) { return w.length > 2; });
  const pool = kb().filter(function (c) { return !c.pin; });
  if (!words.length) return pool.slice(0, 3);
  words = expand(words);
  const scored = pool.map(function (c) {
    const title = (c.title || "").toLowerCase(), text = (c.text || "").toLowerCase();
    let s = 0; words.forEach(function (w) { if (title.indexOf(w) >= 0) s += 3; if (text.indexOf(w) >= 0) s += 1; });
    return { c: c, s: s };
  }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, k || 7);
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

  const fmt = function (c) { return "[" + c.tab + " tab] " + c.title + "\n" + c.text; };
  const pinned = kb().filter(function (c) { return c.pin; }).map(fmt).join("\n\n---\n\n");
  const lastUser = msgs[msgs.length - 1].content;
  const ctx = retrieve(lastUser, 7).map(fmt).join("\n\n---\n\n");
  const system = [
    { type: "text", text: SYS_PROMPT + "\n\n=== CORE PROJECT FACTS (always true) ===\n\n" + pinned, cache_control: { type: "ephemeral" } },
    { type: "text", text: "=== MORE DETAIL RETRIEVED FOR THIS QUESTION ===\n\n" + ctx }
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
