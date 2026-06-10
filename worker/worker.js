// OAI-PMH 2.0 endpoint for tplegacy.net (Cloudflare Worker).
// Reads the dataset produced by build_oai_dataset.py and answers the six verbs.

// ---- CONFIG  ----  edit these four lines ---------------------------------
// DATA_URL: jsDelivr path to your PUBLIC repo. If you name the repo differently,
//           change Jon-tplegacy/tplegacy-oai below.
const DATA_URL    = "https://cdn.jsdelivr.net/gh/Jon-tplegacy/tplegacy-oai@main/data/oai-dataset.json";
// BASE_URL: your workers.dev address. `wrangler deploy` prints it; paste the
//           <subdomain> part here (the worker name is set in wrangler.toml).
const BASE_URL    = "https://tplegacy-oai.<your-subdomain>.workers.dev/oai";
const REPO_NAME   = "The Principle Legacy Archive";
const ADMIN_EMAIL = "andregi2007@gmail.com";
// --------------------------------------------------------------------------

const REPO_NS     = "tplegacy.net";
const PAGE_SIZE   = 100;
const GRANULARITY = "YYYY-MM-DDThh:mm:ssZ";
const EDGE_TTL    = 3600;          // seconds Cloudflare caches the dataset at the edge

let MEMO = null;                   // in-isolate memo to avoid re-parsing within a burst

async function loadData() {
  if (MEMO) return MEMO;
  const res = await fetch(DATA_URL, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
  if (!res.ok) throw new Error("dataset fetch failed: " + res.status);
  MEMO = await res.json();
  return MEMO;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const x = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const b64e = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function b64d(s) {
  try { return JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))); }
  catch { return null; }
}

// Parse a from/until value to epoch ms. Returns null if empty, undefined if malformed.
function parseStamp(s, isUntil) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += isUntil ? "T23:59:59Z" : "T00:00:00Z";
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function envelope(reqAttrs, body) {
  let attr = "";
  for (const k in reqAttrs) if (reqAttrs[k] != null) attr += ` ${k}="${x(reqAttrs[k])}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd">
  <responseDate>${now()}</responseDate>
  <request${attr}>${x(BASE_URL)}</request>
  ${body}
</OAI-PMH>`;
}

const xmlResponse = (s, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });

function oaiError(code, msg, reqAttrs) {
  // For badVerb / badArgument the <request> element must carry no attributes.
  const attrs = (code === "badVerb" || code === "badArgument") ? {} : reqAttrs;
  return xmlResponse(envelope(attrs, `<error code="${code}">${x(msg || code)}</error>`));
}

function headerXml(rec) {
  let s = `<header><identifier>${x(rec.id)}</identifier><datestamp>${x(rec.datestamp)}</datestamp>`;
  for (const set of rec.sets || []) s += `<setSpec>${x(set)}</setSpec>`;
  return s + `</header>`;
}

const DC_ORDER = ["title", "creator", "subject", "description", "publisher", "contributor",
                  "date", "type", "format", "identifier", "source", "language",
                  "relation", "coverage", "rights"];

function dcXml(rec) {
  let m = `<metadata><oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">`;
  const dc = rec.dc || {};
  for (const el of DC_ORDER) {
    for (const v of dc[el] || []) {
      if (v != null && v !== "") m += `<dc:${el}>${x(v)}</dc:${el}>`;
    }
  }
  return m + `</oai_dc:dc></metadata>`;
}

const ALLOWED = {
  Identify: [],
  ListMetadataFormats: ["identifier"],
  ListSets: ["resumptionToken"],
  ListIdentifiers: ["from", "until", "set", "metadataPrefix", "resumptionToken"],
  ListRecords: ["from", "until", "set", "metadataPrefix", "resumptionToken"],
  GetRecord: ["identifier", "metadataPrefix"],
};

async function identify() {
  const data = await loadData();
  const earliest = data.earliestDatestamp || "1970-01-01T00:00:00Z";
  const body = `<Identify>
    <repositoryName>${x(REPO_NAME)}</repositoryName>
    <baseURL>${x(BASE_URL)}</baseURL>
    <protocolVersion>2.0</protocolVersion>
    <adminEmail>${x(ADMIN_EMAIL)}</adminEmail>
    <earliestDatestamp>${x(earliest)}</earliestDatestamp>
    <deletedRecord>no</deletedRecord>
    <granularity>${GRANULARITY}</granularity>
    <description>
      <oai-identifier xmlns="http://www.openarchives.org/OAI/2.0/oai-identifier" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai-identifier http://www.openarchives.org/OAI/2.0/oai-identifier.xsd">
        <scheme>oai</scheme>
        <repositoryIdentifier>${x(REPO_NS)}</repositoryIdentifier>
        <delimiter>:</delimiter>
        <sampleIdentifier>oai:${x(REPO_NS)}:sample</sampleIdentifier>
      </oai-identifier>
    </description>
  </Identify>`;
  return xmlResponse(envelope({ verb: "Identify" }, body));
}

async function listFormats(sp) {
  const id = sp.get("identifier");
  if (id) {
    const data = await loadData();
    if (!data.records.find((r) => r.id === id)) {
      return oaiError("idDoesNotExist", "No such identifier", { verb: "ListMetadataFormats", identifier: id });
    }
  }
  const body = `<ListMetadataFormats>
    <metadataFormat>
      <metadataPrefix>oai_dc</metadataPrefix>
      <schema>http://www.openarchives.org/OAI/2.0/oai_dc.xsd</schema>
      <metadataNamespace>http://www.openarchives.org/OAI/2.0/oai_dc/</metadataNamespace>
    </metadataFormat>
  </ListMetadataFormats>`;
  return xmlResponse(envelope(id ? { verb: "ListMetadataFormats", identifier: id } : { verb: "ListMetadataFormats" }, body));
}

async function listSets() {
  const data = await loadData();
  let body = `<ListSets>`;
  for (const s of data.sets || []) body += `<set><setSpec>${x(s.spec)}</setSpec><setName>${x(s.name)}</setName></set>`;
  return xmlResponse(envelope({ verb: "ListSets" }, body + `</ListSets>`));
}

async function getRecord(sp) {
  const id = sp.get("identifier");
  const mp = sp.get("metadataPrefix");
  const attrs = { verb: "GetRecord", identifier: id, metadataPrefix: mp };
  if (!id || !mp) return oaiError("badArgument", "identifier and metadataPrefix are required", attrs);
  if (mp !== "oai_dc") return oaiError("cannotDisseminateFormat", "Only oai_dc is supported", attrs);
  const data = await loadData();
  const rec = data.records.find((r) => r.id === id);
  if (!rec) return oaiError("idDoesNotExist", "No such identifier", attrs);
  return xmlResponse(envelope(attrs, `<GetRecord><record>${headerXml(rec)}${dcXml(rec)}</record></GetRecord>`));
}

async function listItems(sp, withMeta) {
  const verb = withMeta ? "ListRecords" : "ListIdentifiers";
  const token = sp.get("resumptionToken");
  let mp, from, until, set, offset = 0;

  if (token) {
    for (const k of ["metadataPrefix", "from", "until", "set"]) {
      if (sp.get(k) != null) return oaiError("badArgument", "resumptionToken must be the only argument", { verb });
    }
    const st = b64d(token);
    if (!st) return oaiError("badResumptionToken", "Invalid resumptionToken", { verb });
    ({ m: mp, f: from, u: until, s: set, o: offset } = st);
  } else {
    mp = sp.get("metadataPrefix");
    if (!mp) return oaiError("badArgument", "metadataPrefix is required", { verb });
    if (mp !== "oai_dc") return oaiError("cannotDisseminateFormat", "Only oai_dc is supported", { verb });
    from = sp.get("from");
    until = sp.get("until");
    set = sp.get("set");
  }

  const fromE = parseStamp(from, false);
  const untilE = parseStamp(until, true);
  if (fromE === undefined || untilE === undefined) return oaiError("badArgument", "Malformed from/until", { verb });

  const data = await loadData();
  let recs = data.records;
  if (set) recs = recs.filter((r) => (r.sets || []).includes(set));
  if (fromE != null) recs = recs.filter((r) => Date.parse(r.datestamp) >= fromE);
  if (untilE != null) recs = recs.filter((r) => Date.parse(r.datestamp) <= untilE);

  if (recs.length === 0) return oaiError("noRecordsMatch", "No records match the request", { verb });

  const page = recs.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) return oaiError("badResumptionToken", "Cursor out of range", { verb });

  let body = `<${verb}>`;
  for (const r of page) body += withMeta ? `<record>${headerXml(r)}${dcXml(r)}</record>` : headerXml(r);

  const nextOffset = offset + PAGE_SIZE;
  if (nextOffset < recs.length) {
    const nt = b64e({ m: mp, f: from || null, u: until || null, s: set || null, o: nextOffset });
    body += `<resumptionToken completeListSize="${recs.length}" cursor="${offset}">${x(nt)}</resumptionToken>`;
  } else if (token) {
    // Reached the last page via a token: emit an empty resumptionToken to signal end-of-list.
    body += `<resumptionToken completeListSize="${recs.length}" cursor="${offset}"></resumptionToken>`;
  }
  body += `</${verb}>`;

  const attrs = token
    ? { verb, resumptionToken: token }
    : { verb, metadataPrefix: mp, from: from || null, until: until || null, set: set || null };
  return xmlResponse(envelope(attrs, body));
}

export default {
  async fetch(request) {
    const sp = new URL(request.url).searchParams;

    // Reject repeated arguments -> badArgument
    const counts = {};
    for (const k of sp.keys()) counts[k] = (counts[k] || 0) + 1;
    const dup = Object.keys(counts).find((k) => counts[k] > 1);

    const verb = sp.get("verb");
    if (!verb || !(verb in ALLOWED)) return oaiError("badVerb", "Illegal or missing verb");
    if (dup) return oaiError("badArgument", "Repeated argument: " + dup, { verb });

    const allowed = new Set(["verb", ...ALLOWED[verb]]);
    for (const k of Object.keys(counts)) {
      if (!allowed.has(k)) return oaiError("badArgument", "Unknown argument: " + k, { verb });
    }

    try {
      switch (verb) {
        case "Identify":            return await identify();
        case "ListMetadataFormats": return await listFormats(sp);
        case "ListSets":            return await listSets();
        case "GetRecord":           return await getRecord(sp);
        case "ListIdentifiers":     return await listItems(sp, false);
        case "ListRecords":         return await listItems(sp, true);
      }
    } catch (e) {
      return xmlResponse("temporary error: " + e.message, 503);
    }
  },
};
