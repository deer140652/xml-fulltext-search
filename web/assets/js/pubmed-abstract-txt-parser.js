/*
 * pubmed-abstract-txt-parser.js
 * ------------------------------
 * Parses the plain-text file PubMed itself produces when you select search
 * results and use "Save" → Format: Abstract (Text). That file already
 * contains the full citation (title, authors, journal, year) AND the
 * abstract text for every record — so unlike pmid-fetcher.js, this needs
 * ZERO network requests and is completely unaffected by CORS, since
 * nothing is fetched from anywhere; the data is already right there in
 * the file the person uploaded.
 *
 * Each record looks like:
 *   1. Journal Abbrev. 2021 Jan 15;172:112752. doi: 10.1016/j.xxx.
 *
 *   Article Title Here.
 *
 *   Author A(1), Author B(2), Author C(2).
 *
 *   Author information:
 *   (1)Some affiliation...
 *
 *   The abstract paragraph goes here, potentially spanning several
 *   wrapped lines...
 *
 *   Copyright line (optional)
 *
 *   DOI: 10.1016/j.xxx
 *   PMCID: PMC1234567 (optional — not every record has one)
 *   PMID: 12345678 [Indexed for MEDLINE]
 *
 *   Conflict of interest statement: ... (optional)
 *
 * Records are numbered sequentially (1., 2., 3., ...) — splitting is
 * anchored on that exact sequential numbering (not just "any line
 * starting with digits+period") so a stray number inside an abstract's
 * prose can never be mistaken for a new record boundary.
 */
(function (global) {
  "use strict";

  function splitRecords(text) {
    const lines = text.split(/\r?\n/);
    const starts = [];
    let expected = 1;
    lines.forEach((line, i) => {
      const m = line.match(/^(\d+)\.\s/);
      if (m && parseInt(m[1], 10) === expected) {
        starts.push(i);
        expected++;
      }
    });
    const records = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1] : lines.length;
      records.push(lines.slice(s, e).join("\n").trim());
    }
    return records;
  }

  function isAuthorListBlock(b) {
    const oneLine = b.replace(/\s+/g, " ").trim();
    if (oneLine.length > 300) return false;
    if (/^Author information:/i.test(oneLine)) return false;
    // Unicode-aware: author names can contain accented letters (Yüce, Plaçais, ...)
    const namePart = "\\p{Lu}[\\p{L}.'-]*(?:\\s\\p{Lu}[\\p{L}]*)*(?:\\(\\d+(?:,\\s*\\d+)*\\))?";
    const re = new RegExp(`^(${namePart})(,\\s*(${namePart}))*\\.$`, "u");
    return re.test(oneLine);
  }

  function extractAuthorNames(block) {
    const oneLine = block.replace(/\s+/g, " ").trim().replace(/\.$/, "");
    return oneLine.split(/,\s*/)
      .map((s) => s.replace(/\(\d+(?:,\s*\d+)*\)\s*$/, "").trim())
      .filter(Boolean);
  }

  const FOOTER_RE = /^(DOI:|PMCID:|PMID:|©|Copyright|Conflict of interest|Comment in|Update of|Erratum|Retraction|Publisher:)/i;

  function parseOneRecord(recordText, fallbackId) {
    const blocks = recordText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length < 2) return { ok: false, error: "格式不完整，略過。" };

    const citationLine = blocks[0] || "";
    const pmidM = recordText.match(/PMID:\s*(\d+)/);
    const pmcidM = recordText.match(/PMCID:\s*(PMC\d+)/);
    const yearM = citationLine.match(/\b(19|20)\d{2}\b/);
    const journalM = citationLine.replace(/^\d+\.\s*/, "").match(/^(.+?)\.\s+(?:19|20)\d{2}/);

    let footerStart = blocks.findIndex((b, i) => i > 0 && FOOTER_RE.test(b));
    if (footerStart === -1) footerStart = blocks.length;

    const title = (blocks[1] || "").replace(/\s+/g, " ").trim();

    let authors = [];
    let bodyBlocks = blocks.slice(2, footerStart);
    bodyBlocks = bodyBlocks.filter((b) => {
      if (isAuthorListBlock(b)) {
        authors = extractAuthorNames(b);
        return false;
      }
      return true;
    });
    bodyBlocks = bodyBlocks.filter((b) => !/^Author information:/i.test(b));
    bodyBlocks = bodyBlocks.filter((b) => !/^Comment in/i.test(b));
    bodyBlocks = bodyBlocks.filter((b) => !/^\[.*\]$/.test(b.replace(/\s+/g, " ")));

    const abstract = bodyBlocks.join(" ").replace(/\s+/g, " ").trim();

    if (!title) return { ok: false, error: "找不到標題，略過。" };

    const pmid = pmidM ? pmidM[1] : "";
    const pmcid = pmcidM ? pmcidM[1] : "";
    const fullText = IRCore.joinWithPeriod(title, abstract);
    const stats = IRCore.computeStats(fullText);

    const doc = {
      id: pmcid || (pmid ? "PMID" + pmid : fallbackId),
      pmid,
      title,
      journal: journalM ? journalM[1].trim() : "",
      year: yearM ? yearM[0] : "",
      authors,
      keywords: [],
      abstract,
      abstract_sections: abstract ? [{ title: "", text: abstract }] : [],
      num_paragraphs: 0,
      body_paragraphs: [],
      full_text: fullText,
      stats: {
        num_characters: stats.num_characters,
        num_characters_no_spaces: stats.num_characters_no_spaces,
        num_words: stats.num_words,
        num_sentences: stats.num_sentences,
        avg_words_per_sentence: stats.avg_words_per_sentence,
        num_index_terms: stats.num_index_terms,
        num_unique_stems: stats.num_unique_stems,
      },
      sentences: stats.sentences,
      uploaded: true,
      is_generic_xml: false,
      is_pubmed_abstract_only: true,
    };
    return { ok: true, doc };
  }

  /**
   * @param {string} text raw contents of the .txt file
   * @param {string} fallbackId prefix used if a record has no PMID/PMCID
   * @returns {{ok:true, docs:object[]}|{ok:false, error:string}}
   */
  function parsePubmedAbstractTxt(text, fallbackId) {
    const records = splitRecords(text);
    if (!records.length) return { ok: false, error: "not_this_format" };

    const docs = [];
    records.forEach((r, i) => {
      const result = parseOneRecord(r, `${fallbackId}_${i + 1}`);
      if (result.ok) docs.push(result.doc);
    });

    if (!docs.length) return { ok: false, error: "not_this_format" };
    return { ok: true, docs };
  }

  /** Quick check used to auto-detect this format vs. a bare PMID list. */
  function looksLikePubmedAbstractTxt(text) {
    return /^\d+\.\s/m.test(text) && /PMID:\s*\d+/.test(text);
  }

  global.PubmedAbstractTxtParser = { parsePubmedAbstractTxt, looksLikePubmedAbstractTxt };
})(window);
