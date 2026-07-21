// Cloudflare Worker: proxies BOTH the AI research call and the Airtable
// save, keeping your Anthropic key and Airtable token entirely server-side.
// Anyone using the hosted page never sees either secret.
//
// SETUP (5 minutes):
// 1. In the Cloudflare dashboard, open your existing worker (or create one:
//    Workers & Pages -> Create -> Create Worker -> Edit code).
// 2. Replace all the code with this file. Deploy.
// 3. Settings -> Variables and Secrets -> add four encrypted secrets:
//    - AIRTABLE_BASE_ID    e.g. appE2AHUkyOOL65PC
//    - AIRTABLE_TABLE      e.g. tblRtxwd0dW3DKmt8
//    - AIRTABLE_TOKEN      your Airtable personal access token
//      (must include the schema.bases:read scope, in addition to data
//      read/write, so the /options endpoint can see field choices)
//    - ANTHROPIC_API_KEY   your Anthropic API key (from console.anthropic.com)
// 4. Copy the worker's URL (looks like https://name.subdomain.workers.dev)
//    and paste it into WORKER_BASE_URL near the top of the HTML file's script.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // --- Live select-field options, read straight from Airtable's schema, so
    // newly-added categories/key terms/locations are picked up on the next
    // page load without touching this file. One meta call covers all three. ---
    if (url.pathname === "/options") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }
      const metaUrl = `https://api.airtable.com/v0/meta/bases/${env.AIRTABLE_BASE_ID}/tables`;
      const metaRes = await fetch(metaUrl, {
        headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
      });
      const meta = await metaRes.json();
      if (!metaRes.ok) {
        return new Response(JSON.stringify({ error: meta.error || "Failed to fetch schema" }), {
          status: metaRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const table = (meta.tables || []).find(t => t.id === env.AIRTABLE_TABLE);
      const choicesFor = (fieldName) => {
        const field = table && table.fields.find(f => f.name === fieldName);
        return (field && field.options && field.options.choices)
          ? field.options.choices.map(c => c.name)
          : [];
      };
      const result = {
        categories: choicesFor("expertise categories"),
        keyTerms: choicesFor("key terms"),
        locations: choicesFor("Location based research in"),
        universities: choicesFor("University")
      };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // --- AI research call ---
    if (url.pathname === "/research") {
      const body = await request.text(); // { model, max_tokens, system, messages, tools }
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body
      });
      const data = await anthropicRes.text();
      return new Response(data, {
        status: anthropicRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // --- Airtable save ---
    if (url.pathname === "/save") {
      let fields;
      try {
        const body = await request.json();
        fields = body.fields;
        if (!fields || typeof fields !== "object") throw new Error("Missing fields");
      } catch (e) {
        return new Response(JSON.stringify({ error: "Bad request: " + e.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const airtableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE}`;
      const airtableRes = await fetch(airtableUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ records: [{ fields }], typecast: true })
      });
      const data = await airtableRes.text();
      return new Response(data, {
        status: airtableRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response("Not found. Use /research, /save, or /options.", { status: 404, headers: corsHeaders });
  }
};