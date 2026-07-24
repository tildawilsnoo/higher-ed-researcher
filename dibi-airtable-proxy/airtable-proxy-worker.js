// Cloudflare Worker: proxies the Airtable save/options/duplicate-check
// calls, keeping your Airtable token entirely server-side. Anyone using the
// hosted page never sees that secret.
//
// The AI research call is handled separately by local-research-relay/
// (runs on your machine, authenticated via your Claude subscription seat
// instead of an API key) — see index.html's RESEARCH_BASE_URL.
//
// SETUP (5 minutes):
// 1. In the Cloudflare dashboard, open your existing worker (or create one:
//    Workers & Pages -> Create -> Create Worker -> Edit code).
// 2. Replace all the code with this file. Deploy.
// 3. Settings -> Variables and Secrets -> add three encrypted secrets:
//    - AIRTABLE_BASE_ID    e.g. appE2AHUkyOOL65PC
//    - AIRTABLE_TABLE      e.g. tblRtxwd0dW3DKmt8
//    - AIRTABLE_TOKEN      your Airtable personal access token
//      (must include the schema.bases:read scope, in addition to data
//      read/write, so the /options endpoint can see field choices)
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

    // --- Duplicate check: does this name + university look like it's
    // already in the table? Scans every existing Name/University pair (the
    // table is small enough that a full scan per check is cheap) and scores
    // each one with a normalized Levenshtein similarity, so near-misses
    // (typos, "Dr." prefixes, middle initials) still surface. ---
    if (url.pathname === "/check-duplicate") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }
      const qName = (url.searchParams.get("name") || "").trim();
      const qUni = (url.searchParams.get("university") || "").trim();
      if (!qName) {
        return new Response(JSON.stringify({ matches: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const records = [];
      let offset;
      do {
        const listUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE}`);
        listUrl.searchParams.append("fields[]", "Name");
        listUrl.searchParams.append("fields[]", "University");
        listUrl.searchParams.set("pageSize", "100");
        if (offset) listUrl.searchParams.set("offset", offset);
        const listRes = await fetch(listUrl.toString(), {
          headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
        });
        const listData = await listRes.json();
        if (!listRes.ok) {
          return new Response(JSON.stringify({ error: listData.error || "Failed to list records" }), {
            status: listRes.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        records.push(...(listData.records || []));
        offset = listData.offset;
      } while (offset && records.length < 5000);

      const normalize = (s) => (s || "")
        .toString()
        .toLowerCase()
        .replace(/^(dr|prof|professor|mr|mrs|ms)\.?\s+/i, "")
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      const levenshtein = (a, b) => {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
          const cur = [i];
          for (let j = 1; j <= n; j++) {
            cur[j] = a[i - 1] === b[j - 1]
              ? prev[j - 1]
              : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
          }
          prev = cur;
        }
        return prev[n];
      };
      const similarity = (a, b) => {
        if (!a || !b) return 0;
        return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
      };

      const normName = normalize(qName);
      const normUni = normalize(qUni);

      const matches = [];
      for (const rec of records) {
        const recNameRaw = rec.fields && rec.fields["Name"];
        const recName = normalize(recNameRaw);
        if (!recName) continue;
        const nameSim = similarity(normName, recName);
        if (nameSim < 0.75) continue;

        const recUniRaw = (rec.fields && rec.fields["University"]) || [];
        const uniList = Array.isArray(recUniRaw) ? recUniRaw : [recUniRaw];
        let uniSim = 0;
        for (const u of uniList) {
          uniSim = Math.max(uniSim, similarity(normUni, normalize(u)));
        }
        if (normUni && uniSim < 0.5) continue;

        matches.push({
          id: rec.id,
          name: recNameRaw,
          university: uniList.join(", "),
          nameSimilarity: Math.round(nameSim * 100),
          universitySimilarity: Math.round(uniSim * 100)
        });
      }

      matches.sort((a, b) =>
        (b.nameSimilarity + b.universitySimilarity) - (a.nameSimilarity + a.universitySimilarity));

      return new Response(JSON.stringify({ matches: matches.slice(0, 5) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
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

    return new Response("Not found. Use /save, /options, or /check-duplicate.", { status: 404, headers: corsHeaders });
  }
};