"""
ir_core.py
----------
Core text-processing components for the PubMed IR system:
  1. Rule-based sentence (EOS) segmentation, tuned for biomedical text
     (handles abbreviations like "e.g.", "et al.", "Fig.", decimal numbers,
     units like "mg.", etc.)
  2. Tokenizer
  3. Stop-word list (SMART/standard IR stop-word list, public domain)
  4. Porter Stemmer (classic 1980 Porter algorithm, public-domain method)
  5. Document statistics (characters, words, sentences)

This module is deliberately dependency-free (standard library only) so the
whole pipeline runs anywhere Python 3 runs, with no internet access needed
at build time.

NOTE: this module is intentionally mirrored (same rules, same stopword list,
same stemmer behavior) in web/assets/js/ir-core.js so that the browser can
tokenize/stem a user's *query* the exact same way this script indexed the
*documents*. If you change the rules here, update the JS port too.
"""

import re

# ---------------------------------------------------------------------------
# 1. Stop words (127-word standard IR stop list, public domain / SMART list)
# ---------------------------------------------------------------------------
STOPWORDS = set("""
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
""".split())

# ---------------------------------------------------------------------------
# 2. Rule-based sentence (End-Of-Sentence) segmentation
# ---------------------------------------------------------------------------
# Common abbreviations that must NOT be treated as a sentence boundary even
# though they end with a period. Biomedical-flavored list.
_ABBREVIATIONS = {
    "e.g.", "i.e.", "et al.", "etc.", "vs.", "fig.", "figs.", "no.", "nos.",
    "dr.", "mr.", "mrs.", "ms.", "prof.", "vol.", "pp.", "p.", "approx.",
    "ca.", "cf.", "ref.", "refs.", "eq.", "eqs.", "min.", "max.", "avg.",
    "mg.", "kg.", "ml.", "mmol.", "std.", "sd.", "st.", "jr.", "sr.",
}

# Build a case-insensitive lookup for the *last token* preceding a period.
_ABBR_LAST_WORDS = {a.rstrip('.').split()[-1].lower() for a in _ABBREVIATIONS}


def split_sentences(text: str):
    """
    Rule-based EOS (end-of-sentence) detector.

    Approach:
      1. Normalize whitespace.
      2. Walk the text looking for '.', '!', '?' as candidate boundaries.
      3. A candidate '.' is NOT a boundary if:
           - it is preceded by a known abbreviation (Dr., Fig., et al., ...)
           - it sits between two digits (e.g. "5.6 kg", a decimal number)
           - it is followed immediately by a lowercase letter (likely an
             abbreviation / initialism / URL, e.g. "e.g.something")
      4. '!' and '?' are always boundaries.
      5. A boundary is only "confirmed" once followed by whitespace and
         then an uppercase letter, a digit, an opening quote, or end of text
         (this avoids splitting on periods inside quoted abbreviations).
    Returns a list of sentence strings (whitespace-trimmed, non-empty).
    """
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []

    sentences = []
    start = 0
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        if ch in ".!?":
            is_boundary = True

            if ch == ".":
                # Rule: decimal number, e.g. "8.1%" or "0.001"
                if 0 < i < n - 1 and text[i - 1].isdigit() and text[i + 1].isdigit():
                    is_boundary = False

                # Rule: known abbreviation ending right before this period
                if is_boundary:
                    j = i - 1
                    while j >= 0 and (text[j].isalnum()):
                        j -= 1
                    word = text[j + 1:i].lower()
                    if word in _ABBR_LAST_WORDS:
                        is_boundary = False

                # Rule: single capital letter immediately before period,
                # preceded by a space -> likely an initial (e.g. "H. Chen")
                if is_boundary and i - 1 >= 0 and text[i - 1].isupper():
                    if i - 2 < 0 or text[i - 2] == " ":
                        is_boundary = False

            if is_boundary:
                # Confirm: next non-space char should start a new sentence
                k = i + 1
                while k < n and text[k] == " ":
                    k += 1
                if k < n:
                    nxt = text[k]
                    if not (nxt.isupper() or nxt.isdigit() or nxt in "\"'“‘(["):
                        is_boundary = False
                # else: end of text -> fine, treat as boundary

            if is_boundary:
                sentence = text[start:i + 1].strip()
                if sentence:
                    sentences.append(sentence)
                start = i + 1
        i += 1

    # trailing fragment (no terminal punctuation)
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)

    return sentences


# ---------------------------------------------------------------------------
# 3. Tokenizer
# ---------------------------------------------------------------------------
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]")


def tokenize(text: str):
    """Lowercase alphabetic tokenizer (keeps internal hyphens/apostrophes,
    e.g. 'beta-cell', "patient's"). Numbers are dropped from index terms."""
    return [t.lower() for t in _TOKEN_RE.findall(text)]


def remove_stopwords(tokens):
    return [t for t in tokens if t not in STOPWORDS and len(t) > 1]


# ---------------------------------------------------------------------------
# 4. Porter Stemmer (classic algorithm, Porter 1980)
# ---------------------------------------------------------------------------
class PorterStemmer:
    """A standard implementation of the Porter stemming algorithm."""

    def __init__(self):
        self.b = ""
        self.k = 0
        self.j = 0

    def _cons(self, i):
        ch = self.b[i]
        if ch in "aeiou":
            return False
        if ch == "y":
            return i == 0 or not self._cons(i - 1)
        return True

    def _m(self):
        n = 0
        i = 0
        while True:
            if i > self.j:
                return n
            if not self._cons(i):
                break
            i += 1
        i += 1
        while True:
            while True:
                if i > self.j:
                    return n
                if self._cons(i):
                    break
                i += 1
            i += 1
            n += 1
            while True:
                if i > self.j:
                    return n
                if not self._cons(i):
                    break
                i += 1
            i += 1

    def _vowel_in_stem(self):
        return any(not self._cons(i) for i in range(self.j + 1))

    def _double_cons(self, j):
        return j >= 1 and self.b[j] == self.b[j - 1] and self._cons(j)

    def _cvc(self, i):
        if i < 2 or not self._cons(i) or self._cons(i - 1) or not self._cons(i - 2):
            return False
        return self.b[i] not in "wxy"

    def _ends(self, s):
        if self.b[self.k - len(s) + 1:self.k + 1] == s:
            self.j = self.k - len(s)
            return True
        return False

    def _setto(self, s):
        self.b = self.b[:self.j + 1] + s
        self.k = self.j + len(s)

    def _r(self, s):
        if self._m() > 0:
            self._setto(s)

    def _step1ab(self):
        if self.b[self.k] == "s":
            if self._ends("sses"):
                self.k -= 2
            elif self._ends("ies"):
                self._setto("i")
            elif self.b[self.k - 1] != "s":
                self.k -= 1
        if self._ends("eed"):
            if self._m() > 0:
                self.k -= 1
        elif (self._ends("ed") or self._ends("ing")) and self._vowel_in_stem():
            self.k = self.j
            if self._ends("at"):
                self._setto("ate")
            elif self._ends("bl"):
                self._setto("ble")
            elif self._ends("iz"):
                self._setto("ize")
            elif self._double_cons(self.k):
                self.k -= 1
                if self.b[self.k] in "lsz":
                    self.k += 1
            elif self._m() == 1 and self._cvc(self.k):
                self._setto("e")

    def _step1c(self):
        if self._ends("y") and self._vowel_in_stem():
            self.b = self.b[:self.k] + "i"

    def _step2(self):
        table = [
            ("ational", "ate"), ("tional", "tion"), ("enci", "ence"),
            ("anci", "ance"), ("izer", "ize"), ("bli", "ble"), ("alli", "al"),
            ("entli", "ent"), ("eli", "e"), ("ousli", "ous"), ("ization", "ize"),
            ("ation", "ate"), ("ator", "ate"), ("alism", "al"), ("iveness", "ive"),
            ("fulness", "ful"), ("ousness", "ous"), ("aliti", "al"),
            ("iviti", "ive"), ("biliti", "ble"), ("logi", "log"),
        ]
        for suf, rep in table:
            if self._ends(suf):
                self._r(rep)
                break

    def _step3(self):
        table = [
            ("icate", "ic"), ("ative", ""), ("alize", "al"), ("iciti", "ic"),
            ("ical", "ic"), ("ful", ""), ("ness", ""),
        ]
        for suf, rep in table:
            if self._ends(suf):
                self._r(rep)
                break

    def _step4(self):
        suffixes = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant",
                    "ement", "ment", "ent", "ou", "ism", "ate", "iti", "ous",
                    "ive", "ize"]
        for suf in suffixes:
            if self._ends(suf):
                if self._m() > 1:
                    self.k = self.j
                return
        if self._ends("ion"):
            if self._m() > 1 and self.j >= 0 and self.b[self.j] in "st":
                self.k = self.j

    def _step5(self):
        self.j = self.k
        if self.b[self.k] == "e":
            a = self._m()
            if a > 1 or (a == 1 and not self._cvc(self.k - 1)):
                self.k -= 1
        if self.b[self.k] == "l" and self._double_cons(self.k) and self._m() > 1:
            self.k -= 1

    def stem(self, word: str) -> str:
        word = word.lower()
        if len(word) <= 2:
            return word
        self.b = word
        self.k = len(word) - 1
        self._step1ab()
        if self.k >= 0:
            self._step1c()
            self._step2()
            self._step3()
            self._step4()
            self._step5()
        return self.b[:self.k + 1]


_stemmer = PorterStemmer()


def stem(word: str) -> str:
    # Strip a trailing possessive apostrophe ("cancer's" -> "cancer",
    # "cancers'" -> "cancers") BEFORE running Porter stemming. Without
    # this, the algorithm's own "drop a trailing s" rule can leave the
    # apostrophe dangling (e.g. "cancer's" -> "cancer'"), producing a
    # stem that never matches the plain "cancer" a search would produce.
    cleaned = re.sub(r"'s$|'$", "", word, flags=re.IGNORECASE)
    return _stemmer.stem(cleaned or word)


def stem_all(tokens):
    return [stem(t) for t in tokens]


# ---------------------------------------------------------------------------
# 5. Document statistics
# ---------------------------------------------------------------------------
def expand_hyphenated_tokens(tokens):
    """For a hyphenated compound token like "pre-covid", ALSO index its
    individual hyphen-split parts ("pre", "covid") as separate terms —
    without this, "pre-COVID-19" tokenizes as ONE token "pre-covid" that
    never matches a plain "covid" search, even though the word is right
    there. Keeping the whole compound too (not replacing it) means precise
    multi-word terms like "SARS-CoV-2" or "beta-cell" still work as
    intended; this only ADDS extra recall on top."""
    expanded = []
    for t in tokens:
        expanded.append(t)
        if "-" in t:
            for part in t.split("-"):
                # skip purely-numeric fragments (e.g. the "19" in "covid-19")
                # -- we still don't want bare numbers becoming index terms
                if len(part) > 1 and not part.isdigit():
                    expanded.append(part)
    return expanded


def join_with_period(a: str, b: str) -> str:
    """Joins two pieces of text (typically a title and a body) with ". "
    between them, but WITHOUT adding a redundant period if `a` already
    ends in sentence-ending punctuation -- e.g. a title that already ends
    in "." would otherwise become "title.. body", and the doubled period
    confuses the sentence-boundary detector (neither period ends up
    recognized as a real boundary, merging the title into the body's
    first sentence)."""
    a = (a or "").strip()
    b = (b or "").strip()
    if not a:
        return b
    if not b:
        return a
    sep = " " if a[-1] in ".!?" else ". "
    return a + sep + b


def compute_stats(text: str):
    sentences = split_sentences(text)
    raw_tokens = tokenize(text)
    expanded_tokens = expand_hyphenated_tokens(raw_tokens)
    no_stop_tokens = remove_stopwords(expanded_tokens)
    stems = stem_all(no_stop_tokens)
    words = re.findall(r"\S+", text)
    return {
        "num_characters": len(text),
        "num_characters_no_spaces": len(re.sub(r"\s", "", text)),
        "num_words": len(words),
        "num_sentences": len(sentences),
        "avg_words_per_sentence": round(len(words) / len(sentences), 2) if sentences else 0,
        "num_index_terms": len(no_stop_tokens),
        "num_unique_stems": len(set(stems)),
        "sentences": sentences,
        "tokens": no_stop_tokens,
        "stems": stems,
    }


if __name__ == "__main__":
    # Quick self-test
    demo = ("Dr. Chen reported that HbA1c fell by 1.1% in the metformin-only "
             "group vs. 1.8% in the combined-therapy group (p < 0.001). "
             "Body weight decreased, e.g. by 5.6 kg! Was the difference "
             "significant? Yes, it was significant.")
    for s in split_sentences(demo):
        print("SENT:", s)
    tests = ["running", "flies", "happiness", "national", "connection",
             "connections", "connected", "connecting", "relational",
             "conditional", "rationalization"]
    for w in tests:
        print(w, "->", stem(w))
