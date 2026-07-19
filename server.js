import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On a host with a persistent volume, set DATA_DIR to its mount path so
// conversation history survives redeploys — otherwise it defaults to a
// local folder, which is fine for local runs but wiped on most hosts.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "conversation.json");

// Upstash Redis (REST API — works over plain HTTPS, no persistent connection
// needed) lets conversation memory survive on hosts with no persistent disk,
// like Render's free tier. Falls back to the local file when unset.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = "solara:conversation";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_NAME = process.env.ELEVENLABS_VOICE_NAME || "Daniel";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const PORT = process.env.PORT || 3000;

// Snapshot of the mock business data shown on the dashboard, so SOLARA's
// answers to business questions stay consistent with what's on screen.
const BUSINESS_SNAPSHOT = {
  monthlyRevenue: "$128,400 (+12.4% vs. prior month)",
  newCustomers: "342 (+8.1%)",
  orders: "1,204 (-3.2%)",
  avgOrderValue: "$106.60 (+2.9%)",
  revenueByService: {
    "Web design": "$52,000",
    "Hosting & support": "$31,000",
    "Consulting": "$28,000",
    "Marketing": "$17,400"
  },
  recentInvoices: [
    { date: "Jul 15", client: "Nimbus Robotics", service: "Web design", amount: "$8,200", status: "Paid" },
    { date: "Jul 14", client: "Cascade Realty", service: "Hosting & support", amount: "$640", status: "Paid" },
    { date: "Jul 12", client: "Point & Pine Co.", service: "Consulting", amount: "$3,100", status: "Pending" },
    { date: "Jul 10", client: "Fernwood Clinic", service: "Marketing", amount: "$2,450", status: "Paid" },
    { date: "Jul 08", client: "Vantage Freight", service: "Web design", amount: "$6,800", status: "Overdue" },
    { date: "Jul 05", client: "Basalt Coffee", service: "Hosting & support", amount: "$520", status: "Paid" }
  ]
};

const SYSTEM_PROMPT = `You are SOLARA, a voice assistant embedded in Kevin's business dashboard.
You remember this whole conversation, not just the latest message — use that history naturally,
the way a friend who's been talking with someone all along would.
Speak in short, natural sentences meant to be read aloud — one or two sentences per answer, no lists or markdown.
You're warm and personable, not just a business tool — happy to chat casually about anything.
For questions about the business, answer using this data snapshot and nothing else:
${JSON.stringify(BUSINESS_SNAPSHOT, null, 2)}
For general questions outside the business, answer normally. You have a get_weather tool for current conditions
and forecasts anywhere in the United States — use it when asked about weather; if the location is outside the US,
say the tool only covers the US instead of guessing. For other real-time information you don't have access to,
say so briefly instead of inventing a figure.`;

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather forecast for a US location. Only covers locations within the United States.",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City and state, e.g. 'Renton, WA'" }
    },
    required: ["location"]
  }
};

// A descriptive User-Agent is required by NWS and requested by Nominatim's usage policy.
const GEO_USER_AGENT = "SOLARA-dashboard/1.0 (personal project)";

async function geocodeLocation(location) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`;
  const r = await fetch(url, { headers: { "User-Agent": GEO_USER_AGENT } });
  if (!r.ok) throw new Error(`Geocoding failed: ${r.status}`);
  const results = await r.json();
  if (!results.length) throw new Error(`Couldn't find a location matching "${location}".`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), displayName: results[0].display_name };
}

async function getWeather(location) {
  const { lat, lon, displayName } = await geocodeLocation(location);
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
    headers: { "User-Agent": GEO_USER_AGENT }
  });
  if (!pointsRes.ok) {
    if (pointsRes.status === 404) throw new Error(`"${location}" appears to be outside the US — the National Weather Service only covers US locations.`);
    throw new Error(`NWS points lookup failed: ${pointsRes.status}`);
  }
  const points = await pointsRes.json();
  const forecastRes = await fetch(points.properties.forecast, { headers: { "User-Agent": GEO_USER_AGENT } });
  if (!forecastRes.ok) throw new Error(`NWS forecast lookup failed: ${forecastRes.status}`);
  const forecast = await forecastRes.json();
  const period = forecast.properties.periods[0];
  return `${displayName}: ${period.name} — ${period.detailedForecast}`;
}

// Single running conversation (this is a personal, single-user assistant, not a
// multi-tenant service), persisted to disk so it survives restarts. The full log
// is kept, but only the most recent slice is ever sent to Claude — otherwise the
// context, and the bill, would grow without bound the longer this stays in use.
const RECENT_WINDOW = 40;

const usingRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function loadHistory() {
  if (usingRedis) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await r.json();
      const parsed = data.result ? JSON.parse(data.result) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  if (usingRedis) {
    await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(JSON.stringify(history))
    });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

let conversationHistory = [];

let cachedVoiceId = null;
async function resolveVoiceId() {
  if (cachedVoiceId) return cachedVoiceId;
  const r = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": ELEVENLABS_API_KEY }
  });
  if (!r.ok) throw new Error(`ElevenLabs voice list failed: ${r.status}`);
  const data = await r.json();
  const match = (data.voices || []).find(
    (v) => v.name.toLowerCase() === ELEVENLABS_VOICE_NAME.toLowerCase()
  );
  if (!match) throw new Error(`No ElevenLabs voice named "${ELEVENLABS_VOICE_NAME}" on this account`);
  cachedVoiceId = match.voice_id;
  return cachedVoiceId;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      thinking: { type: "disabled" },
      tools: [WEATHER_TOOL],
      messages
    })
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Claude request failed (${r.status}): ${detail}`);
  }
  return r.json();
}

async function runTool(block) {
  if (block.name === "get_weather") return getWeather(block.input && block.input.location);
  throw new Error(`Unknown tool: ${block.name}`);
}

app.post("/api/ask", async (req, res) => {
  const question = (req.body && req.body.question || "").trim();
  if (!question) return res.status(400).json({ error: "Missing question" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  conversationHistory.push({ role: "user", content: question });

  try {
    let requestMessages = conversationHistory.slice(-RECENT_WINDOW);
    let data = await callClaude(requestMessages);

    let rounds = 0;
    while (data.stop_reason === "tool_use" && rounds < 3) {
      rounds++;
      requestMessages = requestMessages.concat([{ role: "assistant", content: data.content }]);
      const toolResults = [];
      for (const block of data.content.filter((b) => b.type === "tool_use")) {
        try {
          const result = await runTool(block);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        } catch (err) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: err.message, is_error: true });
        }
      }
      requestMessages = requestMessages.concat([{ role: "user", content: toolResults }]);
      data = await callClaude(requestMessages);
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    const answer = (textBlock && textBlock.text || "").trim();
    conversationHistory.push({ role: "assistant", content: answer });
    await saveHistory(conversationHistory);
    res.json({ answer });
  } catch (err) {
    conversationHistory.pop();
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/reset", async (req, res) => {
  conversationHistory = [];
  await saveHistory(conversationHistory);
  res.json({ ok: true });
});

app.post("/api/speak", async (req, res) => {
  const text = (req.body && req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Missing text" });
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured" });

  try {
    const voiceId = await resolveVoiceId();
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "ElevenLabs request failed", detail });
    }
    res.setHeader("content-type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

conversationHistory = await loadHistory();
app.listen(PORT, () => {
  console.log(`SOLARA running at http://localhost:${PORT}${usingRedis ? " (Upstash Redis)" : " (local file)"}`);
});
