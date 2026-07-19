# SOLARA — project notes

A standalone business dashboard with a JARVIS-inspired holographic HUD centerpiece and a
voice assistant ("SOLARA") that can talk about the business or chat generally. Built for
Kevin (solaradigital.net) as an evolving personal project — this file exists so a fresh
session (or Kevin himself) can pick up context without re-reading the whole chat history.

## What's here

- `server.js` — Express backend. Two real API endpoints:
  - `POST /api/ask` — calls Claude (`claude-sonnet-5`, thinking disabled — replies are short
    spoken lines, not reasoning-heavy) with a system prompt containing a mock business data
    snapshot (`BUSINESS_SNAPSHOT`) plus conversation history. Grounds business questions in
    that snapshot; answers general questions normally.
  - `POST /api/speak` — calls ElevenLabs TTS. Looks up the voice by *name* (`ELEVENLABS_VOICE_NAME`,
    default "Daniel") via `/v1/voices` rather than hardcoding a voice ID.
  - `POST /api/reset` — clears conversation history.
  - Conversation memory: full history persists (local JSON file, or Upstash Redis if
    `UPSTASH_REDIS_REST_URL`/`TOKEN` are set — see below), but only the most recent
    `RECENT_WINDOW` (40) messages are sent to Claude per request, to bound cost as the
    conversation grows. Rolls back the pushed user turn if the Claude call fails, so a failed
    request doesn't pollute history.
- `public/index.html` — the whole frontend. Single self-contained file: dark HUD styling
  (near-black void, cyan glow, monospace HUD chrome), a large layered SVG "core" emblem
  (rings, ticks, an equalizer-style bar ring), and the voice interaction UI (tap the core or
  use the quick-ask chips).
- `.env.example` — every env var the app reads, with comments.

## Design history worth knowing

- Started as a generic business-metrics dashboard mockup (KPI tiles, charts, activity table),
  then pivoted hard into a JARVIS-style HUD at Kevin's request. The metrics panels were
  **removed** to focus on nailing the circular core design first — they're not gone forever,
  just deferred. Re-adding them around the core is a natural next step if asked.
- The wordmark is plain "SOLARA" (no acronym-style dots), light font weight, no subtitle.
- Voice: deliberately picked "Daniel" (a stock ElevenLabs voice — calm, British, authoritative)
  instead of attempting to clone the actual JARVIS/Paul Bettany voice, which would be a
  copyright/likeness problem. Don't reintroduce an exact-clone request without flagging that
  concern again.
- Tapping the core starts **real** microphone input (the browser's SpeechRecognition /
  webkitSpeechRecognition API — no server-side STT, no extra cost or API key). Live interim
  transcript renders as you speak; on silence it finalizes and sends the question to Claude.
  Falls back to an on-screen message if the browser doesn't support it (Firefox notably
  doesn't) or if mic permission is denied — quick-ask chips still work either way as a
  keyboard-only path. Requires HTTPS in production (Railway provides this automatically).

## Environment variables (see `.env.example`)

Required: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`.
Notable optional ones: `ANTHROPIC_MODEL` (default `claude-sonnet-5`), `ELEVENLABS_VOICE_NAME`
(default `Daniel`), `DATA_DIR` (persistent-volume mount path, e.g. Railway), or
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (Redis-backed memory, e.g. for Render's
free tier which has no persistent disk — falls back to the local file if unset).

**Never commit real key values.** `.env` and `data/` are gitignored on purpose.

## Status as of last session

- Claude integration (`/api/ask`) is confirmed working end-to-end with real API credits —
  tested grounded business Q&A, multi-turn memory, and general questions.
- Found and fixed a real bug: Claude Sonnet 5 runs adaptive thinking by default, so the
  response's first content block is a `thinking` block, not `text`. Code now finds the actual
  text block instead of assuming `content[0]`.
- ElevenLabs (`/api/speak`) has **not** been tested end-to-end — the sandbox this was built in
  has an egress allowlist that blocks `api.elevenlabs.io`. The code path is written and should
  work once run somewhere without that restriction (should be fine on Railway).
- Deployed to **Railway** (~$5/month Hobby plan, always-on, no idle spin-down — chosen over
  Render's free tier specifically to avoid cold-start delay), with a persistent Volume mounted
  at `/data` and `DATA_DIR=/data` set. Kevin did the account setup and deploy himself; env vars
  entered directly into Railway's dashboard, never committed.
- Working branch: `claude/business-metrics-dashboard-f33ar1` (not yet merged to `main`; no PR
  opened). Railway can deploy straight from this branch without merging first.

## Likely next steps (not yet requested, just the obvious continuations)

- Verify ElevenLabs works for real now that it's deployed on Railway (untestable from the
  sandbox this was built in — see below).
- Re-add the metrics/KPI panels around the core, now that the design language is settled.
- Consider whether "SOLARA" should eventually answer from *real* business data instead of the
  static `BUSINESS_SNAPSHOT` mock.
