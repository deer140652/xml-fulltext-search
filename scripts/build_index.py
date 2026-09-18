"""
build_index.py
---------------
Parses PubMed/PMC JATS XML files in data/raw_pmc/, computes document
statistics (characters, words, sentences via the rule-based segmenter),
builds a TF-IDF weighted inverted index, and writes two JSON files that the
static frontend (web/) loads at runtime:

    web/data/corpus.json   - per-document metadata, stats, and abstract text
                              (used to render results & the stats dashboard)
    web/data/index.json    - inverted index {stem: {doc_id: tf_idf_weight}}
                              plus per-document vector norms and idf table
                              (used to score queries with cosine similarity)

Run:  python3 scripts/build_index.py
"""

import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
import ir_core  # noqa: E402

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw_pmc")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "data")


def text_of(elem):
    """Flatten all text content of an XML element (incl. children),
    joining pieces with a space so text from adjacent tags (e.g. a
    structured abstract's <title>Background</title><p>...</p>) doesn't
    run together into one word. Extra whitespace is collapsed later by
    the caller."""
    if elem is None:
        return ""
    return " ".join(elem.itertext())


def parse_one_article(root, fallback_id):
    """Parses a single <article> element (or an equivalent root for a
    generic, non-JATS XML file) into a document dict. `root` here is
    whatever element we're treating as "the article" — see
    parse_articles_from_file() below for how that's chosen."""
    title_el = root.find(".//article-title")
    if title_el is None:
        title_el = root.find(".//title")

    pmcid_el = root.find(".//article-id[@pub-id-type='pmcid']")
    if pmcid_el is None:
        pmcid_el = root.find(".//article-id[@pub-id-type='pmc']")
    pmcid = text_of(pmcid_el).strip() if pmcid_el is not None else ""

    pmid_el = root.find(".//article-id[@pub-id-type='pmid']")
    pmid = text_of(pmid_el).strip() if pmid_el is not None else ""

    journal_el = root.find(".//journal-title")
    journal = text_of(journal_el).strip() if journal_el is not None else ""

    year_el = root.find(".//pub-date/year")
    if year_el is None:
        year_el = root.find(".//year")
    year = text_of(year_el).strip() if year_el is not None else ""

    authors = []
    for contrib in root.findall(".//contrib[@contrib-type='author']"):
        surname = contrib.find(".//surname")
        given = contrib.find(".//given-names")
        name = " ".join(x.text for x in (given, surname) if x is not None and x.text)
        if name:
            authors.append(name)

    keywords = [text_of(k).strip() for k in root.findall(".//kwd")]

    # These abstract-type values are secondary/redundant blurbs, not the
    # real scholarly abstract — e.g. Wiley journals often ship an
    # <abstract abstract-type="toc"> containing a reworded, shortened
    # restatement of the main abstract, meant for a journal's
    # table-of-contents listing, not the article itself. Skip these so
    # they don't show up as a duplicate "second abstract". Types like
    # "summary" (e.g. ASM's IMPORTANCE statements) are genuinely distinct
    # scholarly content and are kept.
    SKIP_ABSTRACT_TYPES = {"toc", "graphical", "teaser", "short", "web-summary", "highlights", "key points", "keypoints"}

    all_abstract_els = root.findall(".//abstract")
    filtered_els = [el for el in all_abstract_els if (el.get("abstract-type") or "").lower() not in SKIP_ABSTRACT_TYPES]
    # Only apply the skip-list if it still leaves at least one abstract — if
    # a document's ONLY <abstract> happens to carry one of these type labels
    # (some journals tag their real, sole abstract this way, not just
    # redundant secondary blurbs), filtering it out would leave nothing and
    # wrongly trigger the whole-document generic fallback. Better to keep a
    # possibly-redundant abstract than lose the real one.
    abstract_source_els = filtered_els if filtered_els else all_abstract_els

    abstract_sections = []
    for abstract_el in abstract_source_els:
        own_title_el = abstract_el.find("./title")
        own_paras = abstract_el.findall("./p")
        secs = abstract_el.findall("./sec")

        # 1. Text sitting DIRECTLY under <abstract> (a <p>, possibly with its
        #    own <title>) — the "ABSTRACT" part in documents that mix a plain
        #    lead paragraph with a separate <sec> for e.g. "IMPORTANCE",
        #    both inside the SAME <abstract> element.
        if own_paras:
            text = re.sub(r"\s+", " ", " ".join(text_of(p) for p in own_paras)).strip()
            title = re.sub(r"\s+", " ", text_of(own_title_el)).strip() if own_title_el is not None else ""
            if text:
                abstract_sections.append({"title": title, "text": text})

        # 2. Any <sec> children, each becomes its own labeled section.
        for sec in secs:
            sec_title_el = sec.find("./title")
            paras = sec.findall("./p") or sec.findall(".//p")
            sec_text = re.sub(r"\s+", " ", " ".join(text_of(p) for p in paras)).strip()
            sec_title = re.sub(r"\s+", " ", text_of(sec_title_el)).strip() if sec_title_el is not None else ""
            if sec_text:
                abstract_sections.append({"title": sec_title, "text": sec_text})

        # 3. Neither a direct <p> nor a <sec> was found — fall back to this
        #    abstract's whole flattened text so nothing is lost.
        if not own_paras and not secs:
            text = re.sub(r"\s+", " ", text_of(abstract_el)).strip()
            title = re.sub(r"\s+", " ", text_of(own_title_el)).strip() if own_title_el is not None else ""
            if text:
                abstract_sections.append({"title": title, "text": text})

    abstract = " ".join(s["text"] for s in abstract_sections)

    is_generic_xml = False
    if abstract:
        # Has a real <abstract> — per the assignment, only the abstract is
        # indexed, displayed, and matched against. Full article body text
        # is intentionally NOT extracted or used, even if <body><p> exists.
        body_paras = []
    else:
        # No abstract at all (a generic, non-article XML file, or a JATS
        # article missing <abstract>) -> fall back to indexing the WHOLE
        # document's flattened text, since there's no abstract to isolate.
        whole_text = re.sub(r"\s+", " ", text_of(root)).strip()
        body_paras = [whole_text] if whole_text else []
        is_generic_xml = True

    title = text_of(title_el).strip() if title_el is not None else ""
    if not title:
        title = fallback_id

    body_text = " ".join(body_paras)
    full_text = ir_core.join_with_period(title, f"{abstract} {body_text}".strip())

    return {
        "id": pmcid or (("PMID" + pmid) if pmid else "") or fallback_id,
        "pmid": pmid,
        "pmcid": pmcid,
        "title": title,
        "journal": journal,
        "year": year,
        "authors": authors,
        "keywords": keywords,
        "abstract": abstract or (body_paras[0] if body_paras else ""),
        "abstract_sections": abstract_sections,
        "body_paragraphs": body_paras,
        "full_text": full_text,
        "is_generic_xml": is_generic_xml,
    }


def parse_one_pubmed_article(root, fallback_id):
    """Parses ONE <PubmedArticle> element — NCBI's PubMed/MEDLINE citation
    schema (returned by efetch db=pubmed), completely different tag names
    from JATS. This is what you get for a PMID with NO full text in PMC:
    title + structured abstract + authors + journal/year, but NO body
    paragraphs (PubMed itself never carries full article text). Returns
    the SAME shape as parse_one_article() so build() doesn't need to know
    the difference."""
    title_el = root.find(".//ArticleTitle")
    pmid_el = root.find(".//PMID")
    # Even a plain PubMed/MEDLINE citation (db=pubmed) often carries a PMC
    # cross-reference in <PubmedData><ArticleIdList><ArticleId IdType="pmc">
    # -- worth surfacing even though we didn't fetch the full text.
    pmcid_el = root.find(".//ArticleId[@IdType='pmc']")
    journal_el = root.find(".//Journal/Title")
    if journal_el is None:
        journal_el = root.find(".//Journal/ISOAbbreviation")
    year_el = root.find(".//JournalIssue/PubDate/Year")
    if year_el is None:
        year_el = root.find(".//PubDate/Year")

    authors = []
    for author in root.findall(".//AuthorList/Author"):
        given = author.find("./ForeName")
        surname = author.find("./LastName")
        collective = author.find("./CollectiveName")
        name = " ".join(x.text for x in (given, surname) if x is not None and x.text)
        if not name and collective is not None and collective.text:
            name = collective.text.strip()
        if name:
            authors.append(name)

    keywords = [text_of(k).strip() for k in root.findall(".//KeywordList/Keyword")]

    # PubMed structured abstracts use multiple <AbstractText Label="..."> siblings
    # instead of JATS's <sec><title> — each becomes its own labeled section.
    abstract_sections = []
    for el in root.findall(".//Abstract/AbstractText"):
        text = re.sub(r"\s+", " ", text_of(el)).strip()
        label = (el.get("Label") or "").strip()
        if text:
            abstract_sections.append({"title": label, "text": text})
    abstract = " ".join(s["text"] for s in abstract_sections)

    title = text_of(title_el).strip() if title_el is not None else (fallback_id or "")
    pmid = text_of(pmid_el).strip() if pmid_el is not None else fallback_id
    pmcid = text_of(pmcid_el).strip() if pmcid_el is not None else ""

    full_text = ir_core.join_with_period(title, abstract)

    return {
        "id": "PMID" + (pmid or fallback_id or ""),
        "pmid": pmid,
        "pmcid": pmcid,
        "title": title,
        "journal": text_of(journal_el).strip() if journal_el is not None else "",
        "year": text_of(year_el).strip() if year_el is not None else "",
        "authors": authors,
        "keywords": keywords,
        "abstract": abstract,
        "abstract_sections": abstract_sections,
        "body_paragraphs": [],
        "full_text": full_text,
        "is_generic_xml": False,
    }


def parse_articles_from_file(path):
    """Returns a LIST of parsed article dicts from one XML file.

    Detects which schema the file uses:
      - JATS journal article (<article> elements) -> parse_one_article()
      - PubMed/MEDLINE citation (<PubmedArticle> elements, e.g. from
        scripts/fetch_by_pmid_list.py for PMIDs with no PMC full text)
        -> parse_one_pubmed_article()
      - anything else -> treated as one generic XML document

    NCBI's efetch endpoint wraps results in a <pmc-articleset> or
    <PubmedArticleSet> root — and if a batch request covered MULTIPLE IDs
    at once, a single downloaded file can contain several article elements.
    This splits each one into its own separate document instead of
    accidentally mixing their content together.
    """
    tree = ET.parse(path)
    root = tree.getroot()
    base_name = os.path.splitext(os.path.basename(path))[0]

    if root.tag == "article":
        article_elements = [root]
        parse_fn = parse_one_article
    else:
        article_elements = root.findall(".//article")
        if article_elements:
            parse_fn = parse_one_article
        else:
            article_elements = root.findall(".//PubmedArticle")
            if article_elements:
                parse_fn = parse_one_pubmed_article
            else:
                article_elements = [root]  # not a recognized schema -> generic single doc
                parse_fn = parse_one_article

    results = []
    multiple = len(article_elements) > 1
    for i, art_root in enumerate(article_elements):
        fallback_id = f"{base_name}_{i + 1}" if multiple else base_name
        results.append(parse_fn(art_root, fallback_id))
    return results


def build():
    if not os.path.isdir(RAW_DIR):
        os.makedirs(RAW_DIR, exist_ok=True)

    xml_files = sorted(f for f in os.listdir(RAW_DIR) if f.lower().endswith((".xml", ".nxml")))

    if not xml_files:
        # No source XML yet -> ship an EMPTY corpus. The site will show 0
        # documents until the presenter either drops XML files into
        # data/raw_pmc/ and reruns this script, or uploads files live in
        # the browser (which needs no rebuild at all).
        os.makedirs(OUT_DIR, exist_ok=True)
        empty_corpus_stats = {
            "num_documents": 0, "total_words": 0, "total_sentences": 0,
            "total_characters": 0, "vocabulary_size": 0,
        }
        with open(os.path.join(OUT_DIR, "corpus.json"), "w", encoding="utf-8") as f:
            json.dump({"corpus_stats": empty_corpus_stats, "documents": []}, f, ensure_ascii=False, indent=1)
        with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
            json.dump({"idf": {}, "doc_norms": {}, "postings": {}}, f, ensure_ascii=False, indent=1)
        print(f"No XML files in {RAW_DIR} — wrote an EMPTY corpus.json/index.json.")
        print("Drop .xml/.nxml files into data/raw_pmc/ and rerun this script to include them,")
        print("or just upload files live in the browser (no rebuild needed for that).")
        return

    docs = []
    doc_term_freqs = {}  # doc_id -> Counter(stem -> count)
    df = Counter()       # stem -> number of docs containing it
    used_ids = set()

    for fname in xml_files:
        path = os.path.join(RAW_DIR, fname)
        for art in parse_articles_from_file(path):
            doc_id = art["id"]
            if doc_id in used_ids:
                n = 2
                while f"{doc_id}_{n}" in used_ids:
                    n += 1
                doc_id = f"{doc_id}_{n}"
            used_ids.add(doc_id)
            art["id"] = doc_id

            stats = ir_core.compute_stats(art["full_text"])

            term_counts = Counter(stats["stems"])
            doc_term_freqs[art["id"]] = term_counts
            for term in term_counts:
                df[term] += 1

            docs.append({
                "id": art["id"],
                "pmid": art["pmid"],
                "pmcid": art["pmcid"],
                "title": art["title"],
                "journal": art["journal"],
                "year": art["year"],
                "authors": art["authors"],
                "keywords": art["keywords"],
                "abstract": art["abstract"],
                "abstract_sections": art["abstract_sections"],
                "num_paragraphs": len(art["body_paragraphs"]),
                "body_paragraphs": art["body_paragraphs"],
                "full_text": art["full_text"],
                "is_generic_xml": art["is_generic_xml"],
                "stats": {
                    "num_characters": stats["num_characters"],
                    "num_characters_no_spaces": stats["num_characters_no_spaces"],
                    "num_words": stats["num_words"],
                    "num_sentences": stats["num_sentences"],
                    "avg_words_per_sentence": stats["avg_words_per_sentence"],
                    "num_index_terms": stats["num_index_terms"],
                    "num_unique_stems": stats["num_unique_stems"],
                },
                "sentences": stats["sentences"],
            })

    n_docs = len(docs)

    # idf (smoothed) : idf(t) = ln(N / df(t)) + 1
    idf = {term: math.log(n_docs / dfi) + 1.0 for term, dfi in df.items()}

    # tf-idf weights per doc (log-scaled tf) + doc vector norm, for cosine sim
    inverted_index = defaultdict(dict)  # term -> {doc_id: weight}
    doc_norms = {}

    for doc_id, counts in doc_term_freqs.items():
        weights = {}
        for term, tf in counts.items():
            w = (1 + math.log(tf)) * idf[term]
            weights[term] = w
        norm = math.sqrt(sum(w * w for w in weights.values())) or 1.0
        doc_norms[doc_id] = norm
        for term, w in weights.items():
            inverted_index[term][doc_id] = round(w, 6)

    corpus_stats = {
        "num_documents": n_docs,
        "total_words": sum(d["stats"]["num_words"] for d in docs),
        "total_sentences": sum(d["stats"]["num_sentences"] for d in docs),
        "total_characters": sum(d["stats"]["num_characters"] for d in docs),
        "vocabulary_size": len(df),
    }

    os.makedirs(OUT_DIR, exist_ok=True)

    with open(os.path.join(OUT_DIR, "corpus.json"), "w", encoding="utf-8") as f:
        json.dump({"corpus_stats": corpus_stats, "documents": docs}, f, ensure_ascii=False, indent=1)

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "idf": {k: round(v, 6) for k, v in idf.items()},
            "doc_norms": {k: round(v, 6) for k, v in doc_norms.items()},
            "postings": inverted_index,
        }, f, ensure_ascii=False, indent=1)

    print(f"Indexed {n_docs} documents.")
    print(f"Vocabulary size: {len(df)} unique stems.")
    print(f"Wrote {OUT_DIR}/corpus.json and {OUT_DIR}/index.json")


if __name__ == "__main__":
    build()
