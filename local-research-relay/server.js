// Local relay so the DIBI researcher intake page's AI research calls can
// run either against your Claude subscription seat's included usage, or
// against the metered Claude API. index.html has a toggle for this (top of
// the research panel) that sends its choice on every request via the
// X-Relay-Mode header; the RESEARCH_MODE env var below only sets the
// fallback used when that header is missing. Airtable saving stays on the
// Cloudflare Worker exactly as before (see ../dibi-airtable-proxy) — this
// only replaces the /research leg, and only runs on your own machine.
//
// MODES (chosen per-request from the page; RESEARCH_MODE env var sets the
// default, and itself defaults to "agent-sdk"):
//
//   agent-sdk (default) — uses the Claude Agent SDK (Claude Code packaged
//     as a library), NOT the plain Anthropic Messages API SDK — that
//     distinction matters: only Claude Code/Agent SDK traffic draws on
//     your subscription's included usage. Authenticated via whatever
//     account `claude auth login` / `claude setup-token` is currently
//     logged into on this machine — check with `claude auth status` if
//     you're unsure which seat that is.
//     Setup (one time): npm install -g @anthropic-ai/claude-code
//                        claude setup-token   (log in with the seat to bill)
//
//   api — uses the plain Anthropic Messages API SDK directly, billed as
//     metered API usage. Authenticated via ANTHROPIC_API_KEY (env var), or
//     an `ant auth login` OAuth profile if that env var is unset.
//
// RUN (each time you want to use the tool):
//   npm start
// Leave this running in a terminal, then open index.html as usual — it
// points its research calls at http://localhost:8787 by default, and its
// mode toggle picks agent-sdk vs api per request from there.

import http from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";

const PORT = 8787;
const DEFAULT_MODE = process.env.RESEARCH_MODE === "api" ? "api" : "agent-sdk";

// Zero-arg client: resolves ANTHROPIC_API_KEY, or falls back to an
// `ant auth login` OAuth profile, automatically. Constructed unconditionally
// since the page can request api mode per-request regardless of the
// server's default mode; credential resolution happens lazily at request
// time, so this is cheap even when every request ends up using agent-sdk.
const apiClient = new Anthropic();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Relay-Mode",
};

// Runs one research/employment-check request through Claude Code's agent
// loop and returns the final text result, shaped like a raw Anthropic
// Messages API response ({content: [{type: "text", text}]}) so index.html's
// existing response parsing keeps working unchanged.
async function runQueryViaAgentSDK(params) {
  // index.html sends system as an array of cacheable text blocks — flatten
  // to plain text; Claude Code's own prompt caching handles reuse instead.
  const systemText = Array.isArray(params.system)
    ? params.system.map(b => b.text).join("\n")
    : (params.system || "");

  const userMessage = params.messages?.[0]?.content ?? "";

  // The raw Messages API's web_search `max_uses` doesn't have a direct
  // equivalent here — maxTurns (agentic round trips) is the closest lever.
  // Each search plus its reasoning step eats a turn on its own, separate
  // from the turns needed to actually synthesize the answer afterward, so
  // the old "+3" headroom (max_uses 6 -> 9 turns) was hit exactly and
  // killed real research runs before they could produce a result.
  const requestedMaxUses = params.tools?.[0]?.max_uses;
  const maxTurns = requestedMaxUses ? requestedMaxUses * 4 + 10 : 30;

  let finalResult = null;
  let errors = [];

  for await (const message of query({
    prompt: userMessage,
    options: {
      model: params.model,
      systemPrompt: systemText,
      tools: ["WebSearch"],
      allowedTools: ["WebSearch"],
      maxTurns,
      settingSources: [], // isolation mode — ignore any local Claude Code settings
      // No terminal to answer permission prompts in this headless server —
      // without this, tool calls hang forever waiting on an approval that
      // never comes. Scoped to WebSearch only via allowedTools above.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        finalResult = message.result;
      } else {
        errors = message.errors || [message.subtype];
      }
    }
  }

  if (finalResult === null) {
    throw new Error(errors.join("; ") || "No result returned from Claude Code");
  }

  return { content: [{ type: "text", text: finalResult }] };
}

// api mode: index.html's request body is already shaped exactly like a
// Messages API call ({model, max_tokens, system, messages, tools}), so it
// passes straight through — no reshaping needed.
async function runQueryViaApi(params) {
  return apiClient.messages.create(params);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/research") {
    res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found. POST /research only." } }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const requestedMode = req.headers["x-relay-mode"];
    const mode = requestedMode === "api" || requestedMode === "agent-sdk" ? requestedMode : DEFAULT_MODE;
    const params = JSON.parse(body); // { model, max_tokens, system, messages, tools }
    const result = await (mode === "api" ? runQueryViaApi(params) : runQueryViaAgentSDK(params));
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err.status || 500; // Anthropic SDK errors (api mode) carry a real HTTP status
    res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message, type: err.type || err.name } }));
  }
});

server.listen(PORT, () => {
  console.log(`Research relay listening on http://localhost:${PORT} (default mode: ${DEFAULT_MODE})`);
  console.log("The page's mode toggle picks agent-sdk (subscription seat) vs api (metered) per request.");
});
