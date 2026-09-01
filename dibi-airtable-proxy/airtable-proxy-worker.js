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

      // "key terms" is a plain text field (comma-separated), not a select —
      // it grew into a de facto tag cloud and hit Airtable's 10,000-option
      // cap for select fields, so there's no schema choice list to read here.
      // Sample one page of records instead and split their text back apart.
      const sampleUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE}`);
      sampleUrl.searchParams.append("fields[]", "key terms");
      sampleUrl.searchParams.set("pageSize", "100");
      const sampleRes = await fetch(sampleUrl.toString(), {
        headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
      });
      const sampleData = await sampleRes.json();
      const keyTermsSet = new Set();
      for (const rec of (sampleData.records || [])) {
        const raw = rec.fields && rec.fields["key terms"];
        if (!raw) continue;
        for (const term of String(raw).split(",")) {
          const t = term.trim();
          if (t) keyTermsSet.add(t);
        }
      }

      const result = {
        categories: choicesFor("expertise categories"),
        keyTerms: Array.from(keyTermsSet),
        locations: choicesFor("Location based research in"),
        universities: choicesFor("University"),
        otherTags: choicesFor("other tags")
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

      // Make sure the named university is tracked in the separate
      // Institutions table BEFORE the professor record gets created — see
      // maybeAddInstitution() below for what "tracked" means and how its
      // location gets filled in. Deliberately ordered first (this used to
      // run after the professor save, gated on it succeeding) so the
      // university row already exists for the professor to be placed under
      // by the time anyone looks at Airtable, instead of there being a
      // window — or a failed save — where the professor shows up first.
      const uniField = fields["University"];
      const universityName = Array.isArray(uniField) ? uniField[0] : uniField;
      const institution = await maybeAddInstitution(
        env, universityName, fields["city"], fields["State"]
      );

      const airtableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE}`;
      const airtableRes = await fetch(airtableUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ records: [{ fields }], typecast: true })
      });
      const data = await airtableRes.json();
      data.institution = institution;

      return new Response(JSON.stringify(data), {
        status: airtableRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response("Not found. Use /save, /options, or /check-duplicate.", { status: 404, headers: corsHeaders });
  }
};

// --- Institutions table auto-add ---
// The main researcher table names a university per-person, but where that
// university actually IS (city/state/country/coordinates) is tracked once
// per school in a separate Institutions table, not on every researcher
// record. Whenever a save names a university not already in that table,
// this looks it up and adds it — so the institutions sheet grows on its
// own instead of being maintained by hand.
const INSTITUTIONS_TABLE_ID = "tblwk3J6zTVp9JOfe";

async function maybeAddInstitution(env, universityName, city, state) {
  const name = (universityName || "").trim();
  if (!name) return { added: false, reason: "no university given" };

  try {
    // Already tracked? Match case/whitespace-insensitively so "MIT " and
    // "mit" don't both get rows. Scans the whole table the same way
    // /check-duplicate scans the main one — small enough to be cheap.
    const listUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${INSTITUTIONS_TABLE_ID}`);
    listUrl.searchParams.append("fields[]", "institution name");
    listUrl.searchParams.set("pageSize", "100");
    const normalizedTarget = name.toLowerCase();
    let offset;
    do {
      if (offset) listUrl.searchParams.set("offset", offset);
      const listRes = await fetch(listUrl.toString(), {
        headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
      });
      const listData = await listRes.json();
      if (!listRes.ok) {
        return { added: false, reason: "Could not check Institutions table: " + (listData.error?.message || listRes.status) };
      }
      for (const rec of (listData.records || [])) {
        const existing = ((rec.fields && rec.fields["institution name"]) || "").toString().trim().toLowerCase();
        if (existing === normalizedTarget) return { added: false, reason: "already tracked" };
      }
      offset = listData.offset;
    } while (offset);

    // Not tracked — geocode it. Coordinates come from OpenStreetMap's free
    // Nominatim API (no key needed) rather than asking the AI to recall
    // lat/long from memory, which risks confidently-wrong coordinates.
    // Nominatim's usage policy requires a descriptive User-Agent.
    const query = [name, city, state].filter(Boolean).join(", ");
    const geoUrl = new URL("https://nominatim.openstreetmap.org/search");
    geoUrl.searchParams.set("q", query);
    geoUrl.searchParams.set("format", "json");
    geoUrl.searchParams.set("limit", "1");
    geoUrl.searchParams.set("addressdetails", "1");
    const geoRes = await fetch(geoUrl.toString(), {
      headers: { "User-Agent": "dibi-researcher-tool/1.0 (internal Northeastern DIBI tool)" }
    });
    const geoData = await geoRes.json();
    if (!geoRes.ok || !Array.isArray(geoData) || !geoData.length) {
      return { added: false, reason: `Could not geocode "${name}"` };
    }
    const hit = geoData[0];
    const address = hit.address || {};

    // latitude/longitude are Single line text fields, not Number — sent as
    // explicit strings rather than leaving the number->text conversion to
    // typecast. Nominatim returns lat/lon as numeric strings already; the
    // parseFloat round-trip is just to catch a malformed/missing value
    // before it becomes the literal string "NaN" in the table (a raw NaN
    // would otherwise serialize to JSON null, which Airtable rejects for a
    // text field instead of just clearing it — that was the actual error).
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    if (isNaN(lat) || isNaN(lon)) {
      return { added: false, reason: `Nominatim returned no usable coordinates for "${name}"` };
    }

    const instFields = {
      "institution name": name,
      "city": city || address.city || address.town || address.village || "",
      "state": state || address.state || "",
      "Country": address.country || "",
      "latitude": String(lat),
      "longitude": String(lon)
    };

    const createRes = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${INSTITUTIONS_TABLE_ID}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ records: [{ fields: instFields }], typecast: true })
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      return { added: false, reason: "Could not create institution record: " + (createData.error?.message || createRes.status) };
    }
    return { added: true, fields: instFields };
  } catch (e) {
    return { added: false, reason: e.message };
  }
}