// Local relay so the DIBI researcher intake page's AI research calls run
// against your Claude subscription seat's included usage instead of
// metered API billing. Airtable saving stays on the Cloudflare Worker
// exactly as before (see ../dibi-airtable-proxy) — this only replaces the
// /research leg, and only runs on your own machine.
//
// This uses the Claude Agent SDK (Claude Code packaged as a library), not
// the plain Anthropic Messages API SDK — that distinction matters: only
// Claude Code/Agent SDK traffic draws on your subscription's included
// usage. Authenticated via whatever account `claude auth login` /
// `claude setup-token` is currently logged into on this machine — check
// with `claude auth status` before starting this if you're unsure which
// seat that is.
//
// SETUP (one time):
//   1. npm install -g @anthropic-ai/claude-code
//   2. claude setup-token   (log in with the seat you want billed)
//   3. cd local-research-relay && npm install
//
// RUN (each time you want to use the tool):
//   npm start
// Leave this running in a terminal, then open index.html as usual — it
// points its research calls at http://localhost:8787 by default.

import http from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = 8787;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Runs one research/employment-check request through Claude Code's agent
// loop and returns the final text result, shaped like a raw Anthropic
// Messages API response ({content: [{type: "text", text}]}) so index.html's
// existing response parsing keeps working unchanged.
async function runQuery(params) {
  // index.html sends system as an array of cacheable text blocks — flatten
  // to plain text; Claude Code's own prompt caching handles reuse instead.
  const systemText = Array.isArray(params.system)
    ? params.system.map(b => b.text).join("\n")
    : (params.system || "");

  const userMessage = params.messages?.[0]?.content ?? "";

  // The raw Messages API's web_search `max_uses` doesn't have a direct
  // equivalent here — maxTurns (agentic round trips) is the closest lever,
  // so carry the existing budget over with headroom for the final answer.
  const requestedMaxUses = params.tools?.[0]?.max_uses;
  const maxTurns = requestedMaxUses ? requestedMaxUses + 3 : 10;

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
    const params = JSON.parse(body); // { model, max_tokens, system, messages, tools }
    const result = await runQuery(params);
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

server.listen(PORT, () => {
  console.log(`Research relay listening on http://localhost:${PORT}`);
  console.log("Using your Claude subscription seat via Claude Code's stored login.");
});
