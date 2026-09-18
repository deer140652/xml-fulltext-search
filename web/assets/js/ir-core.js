/*
 * ir-core.js
 * ----------
 * Client-side mirror of scripts/ir_core.py.
 * Provides: tokenize(), removeStopwords(), stem(), splitSentences(),
 * computeStats() — used both (a) to process a user's search query the same
 * way documents were indexed, and (b) to power the "try your own text"
 * live document-statistics analyzer in the UI.
 *
 * Pure vanilla JS, no dependencies. Exposed as window.IRCore.
 */
(function (global) {
  "use strict";

  // -------------------------------------------------------------------
  // Stopwords (same 127-word SMART/standard IR list as the Python side)
  // -------------------------------------------------------------------
  const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be
because been before being below between both but by can't cannot could
couldn't did didn't do does doesn't doing don't down during each few for
from further had hadn't has hasn't have haven't having he he'd he'll he's
her here here's hers herself him himself his how how's i i'd i'll i'm i've
if in into is isn't it it's its itself let's me more most mustn't my myself
no nor not of off on once only or other ought our ours ourselves out over
own same shan't she she'd she'll she's should shouldn't so some such than
that that's the their theirs them themselves then there there's these they
they'd they'll they're they've this those through to too under until up
very was wasn't we we'd we'll we're we've were weren't what what's when
when's where where's which while who who's whom why why's with won't would
wouldn't you you'd you'll you're you've your yours yourself yourselves
`.split(/\s+/).filter(Boolean));

  // -------------------------------------------------------------------
  // Rule-based sentence (EOS) segmentation - mirrors ir_core.split_sentences
  // -------------------------------------------------------------------
  const ABBR_LAST_WORDS = new Set([
    "e.g.", "i.e.", "al.", "etc.", "vs.", "fig.", "figs.", "no.", "nos.",
    "dr.", "mr.", "mrs.", "ms.", "prof.", "vol.", "pp.", "p.", "approx.",
    "ca.", "cf.", "ref.", "refs.", "eq.", "eqs.", "min.", "max.", "avg.",
    "mg.", "kg.", "ml.", "mmol.", "std.", "sd.", "st.", "jr.", "sr.",
  ].map((a) => a.replace(/\.$/, "")));

  function isAlnum(ch) {
    return /[A-Za-z0-9]/.test(ch);
  }

  function splitSentences(text) {
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return [];

    const sentences = [];
    let start = 0;
    const n = text.length;

    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (ch === "." || ch === "!" || ch === "?") {
        let isBoundary = true;

        if (ch === ".") {
          // decimal numbers, e.g. "8.1%"
          if (i > 0 && i < n - 1 && /[0-9]/.test(text[i - 1]) && /[0-9]/.test(text[i + 1])) {
            isBoundary = false;
          }
          // known abbreviation
          if (isBoundary) {
            let j = i - 1;
            while (j >= 0 && isAlnum(text[j])) j--;
            const word = text.slice(j + 1, i).toLowerCase();
            if (ABBR_LAST_WORDS.has(word)) isBoundary = false;
          }
          // single capital initial, e.g. "H. Chen"
          if (isBoundary && i - 1 >= 0 && /[A-Z]/.test(text[i - 1])) {
            if (i - 2 < 0 || text[i - 2] === " ") isBoundary = false;
          }
        }

        if (isBoundary) {
          let k = i + 1;
          while (k < n && text[k] === " ") k++;
          if (k < n) {
            const nxt = text[k];
            if (!(/[A-Z0-9]/.test(nxt) || '"\'"‘(['.includes(nxt))) {
              isBoundary = false;
            }
          }
        }

        if (isBoundary) {
          const sentence = text.slice(start, i + 1).trim();
          if (sentence) sentences.push(sentence);
          start = i + 1;
        }
      }
    }
    const tail = text.slice(start).trim();
    if (tail) sentences.push(tail);
    return sentences;
  }

  // -------------------------------------------------------------------
  // Tokenizer
  // -------------------------------------------------------------------
  function tokenize(text) {
    // Must START with a letter (so a bare number like "2020" or "139" is
    // still never captured as a term), but can now contain digits in the
    // middle/end — this lets alphanumeric compounds like "COVID-19" or
    // "SARS-CoV-2" survive tokenization as their OWN distinct term, instead
    // of silently losing the trailing "-19"/"-2" and collapsing into plain
    // "covid"/"sars-cov". A search for "COVID-19" can then match/highlight
    // only "COVID-19" occurrences, not every plain "COVID".
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0].toLowerCase());
    return out;
  }

  function removeStopwords(tokens) {
    return tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  }

  // -------------------------------------------------------------------
  // Porter Stemmer (classic algorithm) - mirrors ir_core.PorterStemmer
  // -------------------------------------------------------------------
  function PorterStemmer() {
    let b = "", k = 0, j = 0;

    function cons(i) {
      const ch = b[i];
      if ("aeiou".includes(ch)) return false;
      if (ch === "y") return i === 0 ? true : !cons(i - 1);
      return true;
    }

    function m() {
      let n = 0, i = 0;
      while (true) {
        if (i > j) return n;
        if (!cons(i)) break;
        i++;
      }
      i++;
      while (true) {
        while (true) {
          if (i > j) return n;
          if (cons(i)) break;
          i++;
        }
        i++;
        n++;
        while (true) {
          if (i > j) return n;
          if (!cons(i)) break;
          i++;
        }
        i++;
      }
    }

    function vowelInStem() {
      for (let i = 0; i <= j; i++) if (!cons(i)) return true;
      return false;
    }

    function doubleCons(x) {
      return x >= 1 && b[x] === b[x - 1] && cons(x);
    }

    function cvc(i) {
      if (i < 2 || !cons(i) || cons(i - 1) || !cons(i - 2)) return false;
      return !"wxy".includes(b[i]);
    }

    function ends(s) {
      if (b.slice(k - s.length + 1, k + 1) === s) {
        j = k - s.length;
        return true;
      }
      return false;
    }

    function setto(s) {
      b = b.slice(0, j + 1) + s;
      k = j + s.length;
    }

    function r(s) {
      if (m() > 0) setto(s);
    }

    function step1ab() {
      if (b[k] === "s") {
        if (ends("sses")) k -= 2;
        else if (ends("ies")) setto("i");
        else if (b[k - 1] !== "s") k -= 1;
      }
      if (ends("eed")) {
        if (m() > 0) k -= 1;
      } else if ((ends("ed") || ends("ing")) && vowelInStem()) {
        k = j;
        if (ends("at")) setto("ate");
        else if (ends("bl")) setto("ble");
        else if (ends("iz")) setto("ize");
        else if (doubleCons(k)) {
          k -= 1;
          if ("lsz".includes(b[k])) k += 1;
        } else if (m() === 1 && cvc(k)) setto("e");
      }
    }

    function step1c() {
      if (ends("y") && vowelInStem()) b = b.slice(0, k) + "i";
    }

    const STEP2 = [
      ["ational", "ate"], ["tional", "tion"], ["enci", "ence"],
      ["anci", "ance"], ["izer", "ize"], ["bli", "ble"], ["alli", "al"],
      ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"],
      ["ation", "ate"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
      ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
      ["iviti", "ive"], ["biliti", "ble"], ["logi", "log"],
    ];
    function step2() {
      for (const [suf, rep] of STEP2) {
        if (ends(suf)) { r(rep); break; }
      }
    }

    const STEP3 = [
      ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
      ["ical", "ic"], ["ful", ""], ["ness", ""],
    ];
    function step3() {
      for (const [suf, rep] of STEP3) {
        if (ends(suf)) { r(rep); break; }
      }
    }

    const STEP4 = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant",
      "ement", "ment", "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize"];
    function step4() {
      for (const suf of STEP4) {
        if (ends(suf)) {
          if (m() > 1) k = j;
          return;
        }
      }
      if (ends("ion")) {
        if (m() > 1 && j >= 0 && "st".includes(b[j])) k = j;
      }
    }

    function step5() {
      j = k;
      if (b[k] === "e") {
        const a = m();
        if (a > 1 || (a === 1 && !cvc(k - 1))) k -= 1;
      }
      if (b[k] === "l" && doubleCons(k) && m() > 1) k -= 1;
    }

    this.stem = function (word) {
      word = word.toLowerCase();
      if (word.length <= 2) return word;
      b = word; k = word.length - 1;
      step1ab();
      if (k >= 0) {
        step1c();
        step2();
        step3();
        step4();
        step5();
      }
      return b.slice(0, k + 1);
    };
  }

  const stemmer = new PorterStemmer();
  function stem(word) {
    // Strip a trailing possessive apostrophe ("cancer's" -> "cancer",
    // "cancers'" -> "cancers") BEFORE running Porter stemming. Without
    // this, the algorithm's own "drop a trailing s" rule can leave the
    // apostrophe dangling (e.g. "cancer's" -> "cancer'"), producing a
    // stem that never matches the plain "cancer" a search would produce.
    const cleaned = word.replace(/'s$|'$/i, "");
    return stemmer.stem(cleaned || word);
  }
  function stemAll(tokens) { return tokens.map(stem); }

  // -------------------------------------------------------------------
  // Document statistics
  // -------------------------------------------------------------------
  function expandHyphenatedTokens(tokens) {
    // For a hyphenated compound token like "pre-covid", ALSO index its
    // individual hyphen-split parts ("pre", "covid") as separate terms —
    // without this, "pre-COVID-19" tokenizes as ONE token "pre-covid" that
    // never matches a plain "covid" search, even though the word is right
    // there. Keeping the whole compound too (not replacing it) means
    // precise multi-word terms like "SARS-CoV-2" or "beta-cell" still work
    // as intended; this only ADDS extra recall on top.
    const expanded = [];
    tokens.forEach((t) => {
      expanded.push(t);
      if (t.includes("-")) {
        t.split("-").forEach((part) => {
          // skip purely-numeric fragments (e.g. the "19" in "covid-19") —
          // we still don't want bare numbers becoming their own index term
          if (part.length > 1 && !/^\d+$/.test(part)) expanded.push(part);
        });
      }
    });
    return expanded;
  }

  function joinWithPeriod(a, b) {
    // Joins two pieces of text (typically a title and a body) with ". "
    // between them, but WITHOUT adding a redundant period if `a` already
    // ends in sentence-ending punctuation — e.g. a title that already ends
    // in "." would otherwise become "title.. body", and the doubled
    // period confuses the sentence-boundary detector (neither period ends
    // up recognized as a real boundary, merging the title into the body's
    // first sentence).
    const aTrim = (a || "").trim();
    const bTrim = (b || "").trim();
    if (!aTrim) return bTrim;
    if (!bTrim) return aTrim;
    const sep = /[.!?]$/.test(aTrim) ? " " : ". ";
    return aTrim + sep + bTrim;
  }

  function computeStats(text) {
    const sentences = splitSentences(text);
    const rawTokens = tokenize(text);
    const expandedTokens = expandHyphenatedTokens(rawTokens);
    const noStop = removeStopwords(expandedTokens);
    const stems = stemAll(noStop);
    const words = (text.match(/\S+/g) || []);
    const numSentences = sentences.length;
    return {
      num_characters: text.length,
      num_characters_no_spaces: text.replace(/\s/g, "").length,
      num_words: words.length,
      num_sentences: numSentences,
      avg_words_per_sentence: numSentences ? Math.round((words.length / numSentences) * 100) / 100 : 0,
      num_index_terms: noStop.length,
      num_unique_stems: new Set(stems).size,
      sentences,
      tokens: noStop,
      stems,
    };
  }

  // -------------------------------------------------------------------
  // TF-IDF index builder — client-side mirror of scripts/build_index.py's
  // indexing step. Lets the browser build (or rebuild) the whole inverted
  // index on the fly, so newly uploaded documents can be merged in without
  // re-running any offline Python step.
  // -------------------------------------------------------------------
  function buildIndex(docs) {
    // docs: array of { id, full_text }
    const df = {};                 // stem -> doc count
    const docTermFreqs = {};       // doc id -> { stem: count }

    docs.forEach((doc) => {
      const stats = computeStats(doc.full_text || "");
      const counts = {};
      stats.stems.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
      docTermFreqs[doc.id] = counts;
      Object.keys(counts).forEach((term) => { df[term] = (df[term] || 0) + 1; });
    });

    const nDocs = docs.length || 1;
    const idf = {};
    Object.keys(df).forEach((term) => {
      idf[term] = Math.log(nDocs / df[term]) + 1.0;
    });

    const postings = {};   // term -> { docId: weight }
    const docNorms = {};

    Object.keys(docTermFreqs).forEach((docId) => {
      const counts = docTermFreqs[docId];
      const weights = {};
      Object.keys(counts).forEach((term) => {
        weights[term] = (1 + Math.log(counts[term])) * idf[term];
      });
      let sumSq = 0;
      Object.values(weights).forEach((w) => { sumSq += w * w; });
      docNorms[docId] = Math.sqrt(sumSq) || 1;
      Object.keys(weights).forEach((term) => {
        if (!postings[term]) postings[term] = {};
        postings[term][docId] = weights[term];
      });
    });

    return { idf, doc_norms: docNorms, postings };
  }

  global.IRCore = {
    STOPWORDS,
    splitSentences,
    tokenize,
    removeStopwords,
    expandHyphenatedTokens,
    joinWithPeriod,
    stem,
    stemAll,
    computeStats,
    buildIndex,
  };
})(window);
