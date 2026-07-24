// Local relay so the DIBI researcher intake page's AI research calls run
// against your Claude Pro/Max seat's included usage instead of metered API
// billing. Airtable saving stays on the Cloudflare Worker exactly as
// before (see ../dibi-airtable-proxy) — this only replaces the /research
// leg, and only runs on your own machine.
//
// SETUP (one time):
// 1. Install the Anthropic CLI (macOS: `brew install anthropics/tap/ant`;
//    other platforms: see the release page for `ant`), then run:
//      ant auth login
//    This opens a browser, logs in with your Claude account, and stores an
//    OAuth profile under ~/.config/anthropic/ (or the platform equivalent).
// 2. cd local-research-relay && npm install
//
// RUN (each time you want to use the tool):
//   npm start
// Leave this running in a terminal, then open index.html as usual — it
// points its research calls at http://localhost:8787 by default.

import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = 8787;

// Zero-arg client: resolves the `ant auth login` OAuth profile
// automatically (no ANTHROPIC_API_KEY needed, no manual token wrangling).
const client = new Anthropic();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
    const message = await client.messages.create(params);
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(message));
  } catch (err) {
    const status = err.status || 500;
    res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message, type: err.type || err.name } }));
  }
});

server.listen(PORT, () => {
  console.log(`Research relay listening on http://localhost:${PORT}`);
  console.log("Using your Claude subscription seat via the `ant auth login` OAuth profile.");
});
