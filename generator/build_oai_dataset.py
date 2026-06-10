#!/usr/bin/env python3
"""
Build the OAI-PMH metadata dataset for tplegacy.net.

Pulls posts from the Ghost Content API, maps each post to unqualified
Dublin Core (oai_dc), and writes a single JSON file. The Cloudflare Worker
reads this file and serves it as a live OAI-PMH endpoint.

Usage:
    python build_oai_dataset.py [output_path]

Env (set as GitHub secrets in CI):
    GHOST_API_URL          e.g. https://tplegacy.net
    GHOST_CONTENT_API_KEY  Ghost Content API key (read-only)

No third-party dependencies (standard library only).
"""

import os
import sys
import json
import datetime
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# CONFIG  ----  adjust to your Ghost taxonomy
# ---------------------------------------------------------------------------
GHOST_API_URL = os.environ.get("GHOST_API_URL", "https://tplegacy.net").rstrip("/")
GHOST_KEY = os.environ.get("GHOST_CONTENT_API_KEY", "")
GHOST_API_VERSION = "v5.0"

REPO_NS = "tplegacy.net"          # OAI identifiers look like  oai:tplegacy.net:<ghost-id>
PUBLISHER = "tplegacy.net"
ARK_NAAN = "68749"
# Rights statement emitted as dc:rights. Set to "" to omit.
RIGHTS = "Non-commercial volunteer archive. Educational and research use."

# primary-tag slug -> (dc:type value, human-readable set name)
TYPE_MAP = {
    "sermons": ("Sermon", "Sermons"),
    "prayers": ("Prayer", "Prayers"),
    "books":   ("Book",   "Books"),
}

# tag slug prefix that encodes language, e.g. "lang-en" -> "en"
LANG_PREFIX = "lang-"
DEFAULT_LANG = None               # set to "en" to always emit a language, or None to omit

# tag slug -> creator display name (extend to match your taxonomy)
CREATOR_MAP = {
    "author-sun-myung-moon":  "Sun Myung Moon",
    "author-hak-ja-han-moon": "Hak Ja Han Moon",
}

# tags that must NOT surface as dc:subject (structural tags)
STRUCTURAL_TAG_SLUGS = set(TYPE_MAP.keys())
STRUCTURAL_TAG_PREFIXES = (LANG_PREFIX, "author-")

PAGE_LIMIT = 100                  # Ghost API page size while harvesting


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def normalize_dt(value):
    """Ghost ISO timestamp -> 'YYYY-MM-DDThh:mm:ssZ' (UTC, second granularity)."""
    if not value:
        return None
    s = value.replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    dt = dt.astimezone(datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def date_only(value):
    n = normalize_dt(value)
    return n[:10] if n else None


def api_get(page):
    query = urllib.parse.urlencode({
        "key": GHOST_KEY,
        "include": "tags,authors",
        "fields": "id,slug,title,url,published_at,updated_at,custom_excerpt,excerpt",
        "limit": str(PAGE_LIMIT),
        "page": str(page),
        "order": "published_at asc",
    })
    url = "%s/ghost/api/content/posts/?%s" % (GHOST_API_URL, query)
    req = urllib.request.Request(url, headers={"Accept-Version": GHOST_API_VERSION})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all_posts():
    posts, page = [], 1
    while True:
        data = api_get(page)
        batch = data.get("posts", [])
        posts.extend(batch)
        nxt = (data.get("meta", {}).get("pagination", {}) or {}).get("next")
        if not nxt:
            break
        page = nxt
    return posts


def map_record(post):
    tags = post.get("tags") or []
    slugs = [t.get("slug", "") for t in tags]

    dc_type, sets = None, []
    for slug in slugs:
        if slug in TYPE_MAP:
            type_value, _ = TYPE_MAP[slug]
            if dc_type is None:
                dc_type = type_value
            sets.append(slug)

    creators = [CREATOR_MAP[s] for s in slugs if s in CREATOR_MAP]
    if not creators:
        creators = [a.get("name") for a in (post.get("authors") or []) if a.get("name")]

    lang = None
    for slug in slugs:
        if slug.startswith(LANG_PREFIX):
            lang = slug[len(LANG_PREFIX):]
            break
    if not lang:
        lang = DEFAULT_LANG

    subjects = []
    for t in tags:
        slug = t.get("slug", "")
        if slug in STRUCTURAL_TAG_SLUGS:
            continue
        if any(slug.startswith(p) for p in STRUCTURAL_TAG_PREFIXES):
            continue
        if t.get("name"):
            subjects.append(t["name"])

    slug = post.get("slug", "")
    ark = "ark:/%s/%s" % (ARK_NAAN, slug)          # align with your existing ARK scheme if different
    url = post.get("url") or "%s/%s/" % (GHOST_API_URL, slug)
    desc = (post.get("custom_excerpt") or post.get("excerpt") or "").strip()

    dc = {
        "title":       [post.get("title", "")],
        "creator":     creators,
        "subject":     subjects,
        "description": [desc] if desc else [],
        "publisher":   [PUBLISHER],
        "date":        [date_only(post.get("published_at"))] if post.get("published_at") else [],
        "type":        [dc_type] if dc_type else [],
        "identifier":  [ark, url],
        "language":    [lang] if lang else [],
        "rights":      [RIGHTS] if RIGHTS else [],
    }

    return {
        "id": "oai:%s:%s" % (REPO_NS, post.get("id")),
        "datestamp": normalize_dt(post.get("updated_at")) or normalize_dt(post.get("published_at")),
        "sets": sets,
        "dc": dc,
    }


def main():
    if not GHOST_KEY:
        sys.exit("ERROR: GHOST_CONTENT_API_KEY is not set.")

    out_path = sys.argv[1] if len(sys.argv) > 1 else "data/oai-dataset.json"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    posts = fetch_all_posts()
    records = [map_record(p) for p in posts]
    records = [r for r in records if r["datestamp"]]  # drop anything without a usable datestamp

    earliest = min((r["datestamp"] for r in records), default="1970-01-01T00:00:00Z")
    sets = [{"spec": slug, "name": name} for slug, (_, name) in TYPE_MAP.items()]

    dataset = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "earliestDatestamp": earliest,
        "sets": sets,
        "records": records,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, separators=(",", ":"))

    print("Wrote %d records to %s (earliest datestamp %s)" % (len(records), out_path, earliest))


if __name__ == "__main__":
    main()
