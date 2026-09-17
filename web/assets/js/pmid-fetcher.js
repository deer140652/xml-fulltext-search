/*
 * pmid-fetcher.js
 * ---------------
 * Given a list of PMIDs, fetches the matching PubMed/MEDLINE citation XML
 * LIVE from NCBI (title + structured abstract + authors + journal/year —
 * no full article body, since PubMed itself never carries that; this
 * assignment only needs the abstract anyway), directly from this browser
 * tab, and parses it with xml-parser.js into the same document shape used
 * everywhere else.
 *
 * Just ONE call, for the whole batch of PMIDs at once:
 *   https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi
 *     ?db=pubmed&id=<id1,id2,...>&retmode=xml
 *
 * (An earlier version of this file first queried the PMC ID Converter API
 * to check for full-text availability, then conditionally fetched PMC
 * full-text XML too — that's no longer needed now that only the abstract
 * matters, and it was also the one step that reliably failed to CORS.
 * Dropping it makes this both simpler AND more likely to just work.)
 *
 * IMPORTANT — NCBI's E-utilities are designed to be called from
 * server-side scripts (their own docs only show Perl/command-line
 * examples), so a browser calling them directly MAY get blocked by CORS.
 * The request below goes through fetchWithCorsFallback(), which tries, in
 * order:
 *   1. A direct request (works if NCBI happens to allow it).
 *   2. YOUR OWN backend proxy, if you've deployed one — see
 *      backend/ncbi-proxy-worker.js for a 5-minute Cloudflare Workers
 *      deployment guide. Set OWN_BACKEND_PROXY below once deployed. This
 *      is the fully reliable option, since it's a server you control.
 *   3. A couple of free, third-party public CORS-proxy services, as a
 *      last-resort best effort (no uptime guarantee).
 * If all of those fail, scripts/fetch_by_pmid_list.py is the offline
 * fallback that does the same job from a normal Python environment,
 * completely unaffected by any of this.
 */
(function (global) {
  "use strict";

  // Once you've deployed backend/ncbi-proxy-worker.js (see that file for
  // the 5-minute setup guide), paste your worker's URL here, e.g.
  // "https://ncbi-proxy.your-subdomain.workers.dev". Leave it as "" to
  // skip straight to the direct request + public-proxy fallbacks.
  const OWN_BACKEND_PROXY = "https://ncbi-proxy.deer140652.workers.dev";

  const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
  const TOOL_NAME = "xml-fulltext-search-classroom-tool";
  const CONTACT_EMAIL = "example@example.com"; // NCBI asks for a contact email; replace with your own if you like
  const BATCH_SIZE = 150; // keep each efetch call to a reasonable batch size

  function extractPmids(text) {
    // Matches the described format ("each line is a PMID"): split on any
    // whitespace/comma/semicolon, then keep tokens that are ENTIRELY
    // digits — this avoids accidentally grabbing a stray 4-digit number
    // (like a year) out of the middle of unrelated text, unlike a bare
    // "any run of digits anywhere" regex would.
    const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const pmids = tokens.filter((t) => /^\d{1,9}$/.test(t));
    return Array.from(new Set(pmids));
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // Free, third-party public CORS proxies — last-resort fallback only, if
  // both the direct request AND your own backend (if configured) fail.
  // No uptime guarantee; this is a best-effort attempt, not a fix.
  const CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];

  async function fetchWithCorsFallback(url) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (directErr) {
      // Try your own backend proxy first, if configured — it's the
      // reliable option since it's a server you control.
      if (OWN_BACKEND_PROXY) {
        try {
          const res = await fetch(`${OWN_BACKEND_PROXY}?url=${encodeURIComponent(url)}`);
          if (res.ok) return res;
        } catch (ownErr) {
          // fall through to the public proxies below
        }
      }
      for (const buildProxyUrl of CORS_PROXIES) {
        try {
          const res = await fetch(buildProxyUrl(url));
          if (res.ok) return res;
        } catch (proxyErr) {
          // try the next proxy
        }
      }
      throw directErr;
    }
  }

  async function efetchPubmedAbstracts(ids) {
    if (!ids.length) return "";
    const url = `${EFETCH_URL}?db=pubmed&id=${ids.join(",")}&retmode=xml&tool=${encodeURIComponent(TOOL_NAME)}&email=${encodeURIComponent(CONTACT_EMAIL)}`;
    const res = await fetchWithCorsFallback(url);
    return res.text();
  }

  /**
   * @param {string[]} pmids
   * @param {(msg:string) => void} onProgress optional progress callback
   * @returns {Promise<{docs:object[], errors:string[]}>}
   */
  async function fetchArticlesForPmids(pmids, onProgress) {
    const report = (msg) => { if (onProgress) onProgress(msg); };
    if (!pmids.length) return { docs: [], errors: ["沒有找到任何有效的 PMID。"] };

    const docs = [];
    const errors = [];

    for (const group of chunk(pmids, BATCH_SIZE)) {
      report(`正在向 PubMed 抓取 ${group.length} 篇文獻的摘要資料…`);
      try {
        const xmlText = await efetchPubmedAbstracts(group);
        const result = PMCXmlParser.parseArticleXML(xmlText, "PMID_batch");
        if (result.ok) docs.push(...result.docs);
        else errors.push(`解析失敗：${result.error}`);
      } catch (e) {
        errors.push(`無法連線到 PubMed（直接連線與備援轉發服務都失敗）：${e.message}——可能是網路問題，或所有管道都被擋。可以改用 scripts/fetch_by_pmid_list.py 在本機下載後，再用「上傳你自己的 XML 文件」加入。`);
      }
    }

    return { docs, errors };
  }

  global.PmidFetcher = { extractPmids, fetchArticlesForPmids };
})(window);
