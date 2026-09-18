/*
 * app.js
 * ------
 * 載入預先建好的範例語料庫（web/data/corpus.json），並讓使用者直接在瀏覽器
 * 上傳 PubMed/PMC XML 檔案（由 xml-parser.js 在前端解析——檔案不會離開瀏覽器，
 * 也沒有伺服器可以接收它），每次文件集合改變時都用 ir-core.js 即時重新建立
 * TF-IDF 反向索引。搜尋時以餘弦相似度為每篇文獻評分，並渲染排序、標示關鍵字
 * 的結果、語料庫統計儀表板，以及即時的句子偵測小工具。
 */
(function () {
  "use strict";

  const UPLOAD_STORAGE_KEY = "pubmedIrLab.uploads.v1";

  let BASE_DOCS = [];      // 來自 web/data/corpus.json（隨網站一起發布的範例語料）
  let UPLOADED_DOCS = [];  // 使用者上傳、在瀏覽器端解析出來的文獻，存在 localStorage
  let ALL_DOCS = [];
  let DOC_BY_ID = {};
  let INDEX_ABSTRACT = { idf: {}, doc_norms: {}, postings: {} }; // 只用摘要文字建的索引
  let INDEX_WITH_TITLE = { idf: {}, doc_norms: {}, postings: {} }; // 標題+摘要建的索引
  let INCLUDE_TITLE = false; // 搜尋框旁邊「包含標題」勾選框的狀態
  let CORPUS_STATS = { num_documents: 0, total_words: 0, total_sentences: 0, total_characters: 0, vocabulary_size: 0 };
  let LAST_MATCHED_TERMS = []; // stems from the most recent search, used to highlight the full-text modal

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 目前生效的索引：依「包含標題」勾選狀態，在兩套預先建好的索引間切換
  function activeIndex() {
    return INCLUDE_TITLE ? INDEX_WITH_TITLE : INDEX_ABSTRACT;
  }

  async function loadBaseCorpus() {
    const res = await fetch("data/corpus.json");
    const data = await res.json();
    BASE_DOCS = data.documents;
  }

  function loadUploadsFromStorage() {
    try {
      const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
      UPLOADED_DOCS = raw ? JSON.parse(raw) : [];
    } catch (e) {
      UPLOADED_DOCS = [];
    }
  }

  function persistUploads() {
    try {
      localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(UPLOADED_DOCS));
    } catch (e) {
      // 儲存空間已滿或無法使用（例如無痕模式）——這裡靜默失敗即可，
      // 本次瀏覽仍可正常使用上傳功能，只是重新整理後不會保留
    }
  }

  // ----------------------------------------------------------------
  // 每當文件集合改變時（上傳／移除），重建整個記憶體中的索引
  // ----------------------------------------------------------------
  // 語料庫總覽只算摘要（不含標題），符合作業「只需要比對摘要」的範圍——
  // 跟搜尋時「包含標題」那個開關是分開的兩件事，這裡固定不算標題。
  function abstractStats(doc) {
    return IRCore.computeStats(doc.abstract || "");
  }

  function rebuildAll() {
    ALL_DOCS = BASE_DOCS.concat(UPLOADED_DOCS);
    DOC_BY_ID = {};
    ALL_DOCS.forEach((d) => { DOC_BY_ID[d.id] = d; });

    // 建兩套獨立的索引：TF-IDF 的 idf 值取決於「整個語料庫」的範圍，所以
    // 不能只建一套索引、搜尋時再挑要不要看標題——那樣 idf 會算錯。摘要版跟
    // 標題+摘要版分開各自建一次，搜尋時依照「包含標題」的勾選狀態去選用
    // 對應的那一套（見 activeIndex()）。
    INDEX_ABSTRACT = IRCore.buildIndex(ALL_DOCS.map((d) => ({ id: d.id, full_text: d.abstract || "" })));
    INDEX_WITH_TITLE = IRCore.buildIndex(ALL_DOCS.map((d) => ({ id: d.id, full_text: d.full_text })));

    CORPUS_STATS = {
      num_documents: ALL_DOCS.length,
      total_words: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_words, 0),
      total_sentences: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_sentences, 0),
      total_characters: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_characters, 0),
      vocabulary_size: Object.keys(activeIndex().postings).length,
    };

    const hintEl = $("#example-chips-wrap");
    if (hintEl) hintEl.hidden = ALL_DOCS.length > 0;
  }

  // ----------------------------------------------------------------
  // 搜尋：TF-IDF 向量空間模型 + 餘弦相似度
  // ----------------------------------------------------------------
  function scoreQuery(queryText) {
    // PubMed-style wildcard/truncation search: a word ending in "*" expands
    // to every indexed stem that STARTS WITH the text before the "*" (e.g.
    // "confirm*" matches confirm/confirmed/confirms/confirming), instead of
    // requiring an exact stem match. Words without "*" go through the normal
    // tokenize -> stopword-removal -> stem pipeline as before.
    const rawWords = queryText.trim().split(/\s+/).filter(Boolean);
    const wildcardWords = rawWords.filter((w) => w.length > 1 && w.endsWith("*"));
    const normalWordsText = rawWords.filter((w) => !(w.length > 1 && w.endsWith("*"))).join(" ");

    const rawTokens = IRCore.tokenize(normalWordsText);
    // NOTE: deliberately NOT expanding hyphenated query terms here (unlike
    // the document side in ir-core.js's computeStats) — a search for
    // "pre-covid" should stay specific to that compound, not silently
    // broaden into also matching every standalone "covid". Expansion only
    // happens when INDEXING documents, so a plain "covid" search can still
    // find "pre-COVID-19" inside a document, without the reverse happening.
    const qTerms = IRCore.stemAll(IRCore.removeStopwords(rawTokens));
    const stopwordsFound = rawTokens.filter((t) => IRCore.STOPWORDS.has(t));

    const qCounts = {};
    qTerms.forEach((t) => { qCounts[t] = (qCounts[t] || 0) + 1; });

    const qWeights = {};
    const matchedTerms = new Set();
    for (const term in qCounts) {
      const idf = activeIndex().idf[term];
      if (idf === undefined) continue;
      matchedTerms.add(term);
      qWeights[term] = (1 + Math.log(qCounts[term])) * idf;
    }

    // Expand each "prefix*" word into every matching indexed stem.
    const expandedWildcardTerms = [];
    wildcardWords.forEach((w) => {
      const prefixTokens = IRCore.tokenize(w.slice(0, -1)); // strip trailing "*"
      const prefix = prefixTokens.join("");
      if (!prefix) return;
      Object.keys(activeIndex().idf)
        .filter((term) => term.startsWith(prefix))
        .forEach((term) => {
          matchedTerms.add(term);
          expandedWildcardTerms.push(term);
          // treat as if the user typed this exact matching word once
          const w2 = activeIndex().idf[term]; // log(1) tf-weight = 1 * idf
          qWeights[term] = Math.max(qWeights[term] || 0, w2);
        });
    });

    if (qTerms.length === 0 && expandedWildcardTerms.length === 0) {
      return {
        results: [], matchedTerms: [],
        rawTokenCount: rawTokens.length,
        allStopwords: wildcardWords.length === 0 && rawTokens.length > 0 && stopwordsFound.length === rawTokens.length,
        stopwordsFound: Array.from(new Set(stopwordsFound)),
        hadWildcard: wildcardWords.length > 0,
      };
    }

    const qNorm = Math.sqrt(Object.values(qWeights).reduce((s, w) => s + w * w, 0)) || 1;

    const scores = {};
    for (const term in qWeights) {
      const postings = activeIndex().postings[term];
      if (!postings) continue;
      for (const docId in postings) {
        scores[docId] = (scores[docId] || 0) + postings[docId] * qWeights[term];
      }
    }

    const results = Object.keys(scores).map((docId) => {
      const cosine = scores[docId] / (qNorm * (activeIndex().doc_norms[docId] || 1));
      return { doc: DOC_BY_ID[docId], score: cosine };
    }).filter((r) => r.doc);

    results.sort((a, b) => b.score - a.score);
    return { results, matchedTerms: Array.from(matchedTerms) };
  }

  // ----------------------------------------------------------------
  // 渲染輔助函式
  // ----------------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function isHighlightMatch(word, matchedStems) {
    // Used only to decide WHETHER a token has any match at all (e.g. for
    // picking where to center a snippet) — see renderToken() below for the
    // actual character-level rendering, which only marks the specific
    // matching segment(s) of a hyphenated compound, not the whole thing.
    const w = word.toLowerCase();
    if (matchedStems.includes(IRCore.stem(w))) return true;
    if (w.includes("-")) {
      return w.split("-").some((part) => part.length > 1 && matchedStems.includes(IRCore.stem(part)));
    }
    return false;
  }

  function countMatches(text, matchedStems) {
    if (!text || !matchedStems || matchedStems.length === 0) return 0;
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let count = 0, mm;
    while ((mm = re.exec(text)) !== null) {
      if (isHighlightMatch(mm[0], matchedStems)) count++;
    }
    return count;
  }

  function renderToken(word, matchedStems) {
    // If the WHOLE token's own stem matches (covers plain words, and a
    // hyphenated query like "pre-covid" matching that exact compound),
    // mark the whole token. Otherwise, for a hyphenated word, check each
    // "-"-separated segment independently and mark ONLY the segment(s)
    // that match — e.g. searching "covid" highlights just "COVID" inside
    // "pre-COVID-19", leaving "pre" as plain text.
    const wLower = word.toLowerCase();
    if (matchedStems.includes(IRCore.stem(wLower))) {
      return `<mark>${escapeHtml(word)}</mark>`;
    }
    if (word.includes("-")) {
      const parts = word.split("-");
      let anyMatch = false;
      const rendered = parts.map((part) => {
        const isMatch = part.length > 1 && matchedStems.includes(IRCore.stem(part.toLowerCase()));
        if (isMatch) anyMatch = true;
        return isMatch ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part);
      });
      if (anyMatch) return rendered.join("-");
    }
    return escapeHtml(word);
  }

  function highlightSnippet(text, matchedStems, maxLen) {
    maxLen = maxLen || 320;
    const tokenRe = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let m, hitIndex = -1;
    while ((m = tokenRe.exec(text)) !== null) {
      if (isHighlightMatch(m[0], matchedStems)) {
        hitIndex = m.index;
        break;
      }
    }
    let start = 0;
    if (hitIndex > maxLen / 2) start = hitIndex - Math.floor(maxLen / 2);
    let snippet = text.slice(start, start + maxLen);
    if (start > 0) snippet = "…" + snippet;
    if (start + maxLen < text.length) snippet = snippet + "…";

    let html = "";
    let last = 0;
    const re2 = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let mm;
    while ((mm = re2.exec(snippet)) !== null) {
      const word = mm[0];
      html += escapeHtml(snippet.slice(last, mm.index));
      html += renderToken(word, matchedStems);
      last = mm.index + word.length;
    }
    html += escapeHtml(snippet.slice(last));
    return html;
  }

  function highlightFullText(text, matchedStems) {
    // Like highlightSnippet, but marks every match across the WHOLE text
    // with no cropping — used in the full-article modal.
    if (!text) return "";
    if (!matchedStems || matchedStems.length === 0) return escapeHtml(text);
    let html = "";
    let last = 0;
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const word = mm[0];
      html += escapeHtml(text.slice(last, mm.index));
      html += renderToken(word, matchedStems);
      last = mm.index + word.length;
    }
    html += escapeHtml(text.slice(last));
    return html;
  }

  function renderResults(queryText) {
    const resultsEl = $("#results");
    const countEl = $("#result-count");

    if (!queryText.trim()) {
      resultsEl.innerHTML = "";
      countEl.textContent = "";
      LAST_MATCHED_TERMS = [];
      renderCorpusOverview();
      return;
    }

    const { results, matchedTerms, allStopwords, stopwordsFound, rawTokenCount, hadWildcard } = scoreQuery(queryText);

    countEl.textContent = results.length
      ? `符合「${queryText}」的文獻：${results.length} / ${ALL_DOCS.length} 篇`
      : `沒有符合「${queryText}」的文獻`;

    if (results.length === 0) {
      if (allStopwords) {
        resultsEl.innerHTML = `<p class="empty-state">「${stopwordsFound.map((w) => `<code>${escapeHtml(w)}</code>`).join("、")}」是<strong>停用詞（stopword）</strong>——像 and、is、the、of 這類字幾乎每篇文獻都會出現，對檢索沒有鑑別度，系統會依照標準 IR 前處理流程自動忽略，不納入比對。請改搜尋有實際意義的關鍵字，例如疾病、藥物、症狀、方法等名詞。</p>`;
      } else if (hadWildcard) {
        resultsEl.innerHTML = `<p class="empty-state">沒有任何索引詞是以這個字首開頭的。萬用字元 <code>*</code> 是比對「已建索引的字幹」，試試更短的字首，或先確認語料庫裡有沒有相關字詞。</p>`;
      } else if (rawTokenCount === 0) {
        resultsEl.innerHTML = `<p class="empty-state">請輸入至少一個英文字母組成的關鍵字。</p>`;
      } else {
        resultsEl.innerHTML = `<p class="empty-state">沒有符合的文獻。試試更廣泛的關鍵字——系統以「字幹」（stem）比對，所以 "vaccinated" 也會比對到 "vaccine"；或在字尾加 <code>*</code> 做前綴搜尋，例如 <code>confirm*</code>。</p>`;
      }
      LAST_MATCHED_TERMS = matchedTerms;
      return;
    }
    LAST_MATCHED_TERMS = matchedTerms;

    resultsEl.innerHTML = results.map(({ doc, score }, i) => {
      const snippet = highlightSnippet(doc.abstract, matchedTerms);
      const pct = Math.round(score * 100);
      const titleHtml = INCLUDE_TITLE ? highlightFullText(doc.title, matchedTerms) : escapeHtml(doc.title);
      const hitText = INCLUDE_TITLE ? `${doc.title} ${doc.abstract || ""}` : (doc.abstract || "");
      const hitCount = countMatches(hitText, matchedTerms);
      const authors = doc.authors || [];
      const authorDisplay = authors.length > 3
        ? `${authors.slice(0, 3).join(", ")} et al.`
        : (authors.join(", ") || "—");
        
      return `
        <article class="result-card" style="--rank-delay:${i * 40}ms">
          <div class="result-rank">#${i + 1}</div>
          <div class="result-body">
            <h3>${titleHtml}${/* doc.uploaded ? ' <span class="uploaded-tag">已上傳</span>' : "" */ ""}${doc.is_generic_xml ? ' <span class="generic-tag">一般 XML（非期刊格式）</span>' : ""}</h3>
            <p class="result-meta">${escapeHtml(doc.journal || "—")} · ${escapeHtml(doc.year || "—")} · ${escapeHtml(authorDisplay)}</p>
            <p class="result-ids"><span class="pmid">PMID: ${escapeHtml(doc.pmid || "—")}</span>${doc.pmcid ? `<span class="pmid">PMCID: ${escapeHtml(doc.pmcid)}</span>` : ""}</p>
            <p class="result-snippet">${snippet}</p>
            <div class="result-footer">
              <span class="score-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
              <span class="score-label">相關度 ${pct}% · 命中 ${hitCount} 個關鍵字</span>
              <button class="link-btn" data-doc="${doc.id}">查看完整文章（標示命中關鍵字）→</button>
            </div>
          </div>
        </article>`;
    }).join("");

    $$(".link-btn[data-doc]").forEach((btn) => {
      btn.addEventListener("click", () => openDocModal(btn.dataset.doc));
    });
  }

  function rerenderCurrent() {
    renderResults($("#search-input").value);
  }

  // ----------------------------------------------------------------
  // 語料庫總覽儀表板
  // ----------------------------------------------------------------
  function renderCorpusOverview() {
    const cs = CORPUS_STATS;
    $("#stat-docs").textContent = cs.num_documents;
    $("#stat-words").textContent = cs.total_words.toLocaleString();
    $("#stat-sentences").textContent = cs.total_sentences.toLocaleString();
    $("#stat-vocab").textContent = cs.vocabulary_size.toLocaleString();

    const max = Math.max(1, ...ALL_DOCS.map((d) => abstractStats(d).num_words));
    $("#doc-bars").innerHTML = ALL_DOCS.length === 0
      ? `<p class="empty-state small">尚未有任何文獻，請上傳 .xml 檔案。</p>`
      : ALL_DOCS.map((d) => {
      const ds = abstractStats(d);
      const w = Math.round((ds.num_words / max) * 100);
      const idParts = [];
      if (d.pmid) idParts.push(d.pmid);
      if (d.pmcid) idParts.push(d.pmcid);
      const label = idParts.length ? idParts.join(" · ") : d.id.replace("PMC_sample_", "PMC-");
      return `
        <div class="bar-row" data-doc="${d.id}" title="點擊查看：${escapeHtml(d.title)}">
          <span class="bar-label-row">
            <span class="bar-label">${escapeHtml(label)}${/* d.uploaded ? " ★" : "" */ ""}</span>
            <span class="bar-value">${ds.num_words}字/${ds.num_sentences}句</span>
          </span>
          <span class="bar-track"><span class="bar-fill" style="width:${w}%"></span></span>
        </div>`;
    }).join("");
    $$(".bar-row[data-doc]").forEach((row) => {
      row.addEventListener("click", () => openDocModal(row.dataset.doc));
    });

    $("#results").innerHTML = "";
    $("#result-count").textContent = "";
  }

  // ----------------------------------------------------------------
  // 文獻詳細視窗（完整統計 + 句子切分結果）
  // ----------------------------------------------------------------
  function openDocModal(docId) {
    const doc = DOC_BY_ID[docId];
    if (!doc) return;
    const modal = $("#doc-modal");
    const terms = LAST_MATCHED_TERMS;

    // Stats & sentence breakdown are computed fresh here (not from the
    // precomputed doc.stats/doc.sentences, which always include the
    // title) so they correctly follow the "搜尋時包含標題" toggle: with it
    // off, only the abstract is counted/listed; with it on, the title is
    // included in both the numbers and the sentence list.
    const statsSourceText = INCLUDE_TITLE ? IRCore.joinWithPeriod(doc.title, doc.abstract || "") : (doc.abstract || "");
    const s = IRCore.computeStats(statsSourceText);

    $("#doc-modal-title").innerHTML = INCLUDE_TITLE ? highlightFullText(doc.title, terms) : escapeHtml(doc.title);
    $("#doc-modal-meta").innerHTML = `${escapeHtml(doc.journal || "—")} · ${escapeHtml(doc.year || "—")} · ${escapeHtml((doc.authors || []).join(", ") || "—")}<br><span class="pmid">PMID: ${escapeHtml(doc.pmid || "—")}</span>${doc.pmcid ? `<span class="pmid">PMCID: ${escapeHtml(doc.pmcid)}</span>` : ""}`;
    $("#doc-modal-stats").innerHTML = [
      ["字元數", s.num_characters.toLocaleString()],
      ["字元數（不含空白）", s.num_characters_no_spaces.toLocaleString()],
      ["字數", s.num_words.toLocaleString()],
      ["句數", s.num_sentences.toLocaleString()],
      //["平均每句字數", s.avg_words_per_sentence],
      ["索引詞數（過濾停用詞後）", s.num_index_terms.toLocaleString()],
      ["唯一詞幹數", s.num_unique_stems.toLocaleString()],
    ].map(([label, val]) => `<div class="stat-chip"><span>${label}</span><strong>${val}</strong></div>`).join("");

    // full-text panel: abstract + every body paragraph, with the current
    // search's matched terms highlighted throughout (not just a snippet)
    const paras = (doc.body_paragraphs && doc.body_paragraphs.length) ? doc.body_paragraphs : [];
    const displayedText = (INCLUDE_TITLE ? [doc.title] : []).concat([doc.abstract]).concat(paras).join(" ");
    const hitCount = countMatches(displayedText, terms);

    $("#doc-modal-match-banner").innerHTML = terms.length
      ? `<span class="match-banner-count">${hitCount}</span> 個關鍵字命中處已用 <mark>反白</mark> 標示${INCLUDE_TITLE ? "（含標題）" : ""}`
      : "";
    $("#doc-modal-match-banner").hidden = terms.length === 0;

    let fulltextHtml = "";
    if (doc.abstract_sections && doc.abstract_sections.length) {
      doc.abstract_sections.forEach((sec) => {
        if (sec.title) {
          fulltextHtml += `<p class="doc-fulltext-abstract-label">${escapeHtml(sec.title)}</p>`;
        }
        fulltextHtml += `<p>${highlightFullText(sec.text, terms)}</p>`;
      });
    } else if (doc.abstract) {
      fulltextHtml += `<p>${highlightFullText(doc.abstract, terms)}</p>`;
    }
    if (paras.length) {
      fulltextHtml += `<p class="doc-fulltext-abstract-label">Content</p>`;
      fulltextHtml += paras.map((p) => `<p>${highlightFullText(p, terms)}</p>`).join("");
    }
    if (!fulltextHtml) {
      fulltextHtml = `<p class="empty-state small">這份文件沒有可顯示的內文。</p>`;
    }
    $("#doc-modal-fulltext").innerHTML = fulltextHtml;

    $("#doc-modal-sentences").innerHTML = s.sentences
      .map((sent, i) => `<li><span class="sent-idx">${i + 1}</span>${escapeHtml(sent)}</li>`)
      .join("");
    modal.showModal();
  }

  // ----------------------------------------------------------------
  // 上傳面板：在瀏覽器端解析 PMC/JATS XML
  // ----------------------------------------------------------------
  function renderUploadPanel() {
    const listEl = $("#upload-list");
    const countEl = $("#upload-count");
    countEl.textContent = UPLOADED_DOCS.length
      ? `已上傳 ${UPLOADED_DOCS.length} 篇文獻`
      : "尚未上傳任何文獻。";
    listEl.innerHTML = UPLOADED_DOCS.map((d) => `
      <li>
        <span class="upload-title">${escapeHtml(d.title)}</span>
        <button class="remove-upload" data-id="${escapeHtml(d.id)}" aria-label="移除">×</button>
      </li>`).join("");
    $$(".remove-upload").forEach((btn) => {
      btn.addEventListener("click", () => removeUpload(btn.dataset.id));
    });
    $("#upload-reset").hidden = UPLOADED_DOCS.length === 0;
  }

  function setUploadStatus(msg, isError) {
    const el = $("#upload-status");
    el.textContent = msg;
    el.classList.toggle("upload-status-error", !!isError);
  }

  function uniqueId(baseId) {
    if (!DOC_BY_ID[baseId] && !UPLOADED_DOCS.some((d) => d.id === baseId)) return baseId;
    let n = 2;
    while (DOC_BY_ID[`${baseId}_${n}`] || UPLOADED_DOCS.some((d) => d.id === `${baseId}_${n}`)) n++;
    return `${baseId}_${n}`;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.(xml|nxml)$/i.test(f.name));
    if (files.length === 0) {
      setUploadStatus("請選擇 .xml 或 .nxml 檔案。", true);
      return;
    }
    let added = 0, failed = [];
    for (const file of files) {
      let text;
      try {
        text = await file.text();
      } catch (e) {
        failed.push(`${file.name}：無法讀取檔案`);
        continue;
      }
      const fallbackId = file.name.replace(/\.(xml|nxml)$/i, "");
      const result = PMCXmlParser.parseArticleXML(text, fallbackId);
      if (!result.ok) {
        failed.push(`${file.name}：${result.error}`);
        continue;
      }
      result.docs.forEach((doc) => {
        doc.id = uniqueId(doc.id);
        UPLOADED_DOCS.push(doc);
        added++;
      });
    }

    if (added > 0) {
      persistUploads();
      rebuildAll();
      renderUploadPanel();
      renderCorpusOverview();
      rerenderCurrent();
    }

    if (added && !failed.length) {
      setUploadStatus(`已新增 ${added} 篇文獻，已完成索引，現在就能搜尋。`, false);
    } else if (added && failed.length) {
      setUploadStatus(`已新增 ${added} 篇，但有 ${failed.length} 篇失敗：${failed.join("；")}`, true);
    } else {
      setUploadStatus(`無法新增任何檔案：${failed.join("；")}`, true);
    }
  }

  function removeUpload(id) {
    UPLOADED_DOCS = UPLOADED_DOCS.filter((d) => d.id !== id);
    persistUploads();
    rebuildAll();
    renderUploadPanel();
    renderCorpusOverview();
    rerenderCurrent();
    setUploadStatus("已移除。", false);
  }

  function resetUploads() {
    UPLOADED_DOCS = [];
    persistUploads();
    rebuildAll();
    renderUploadPanel();
    renderCorpusOverview();
    rerenderCurrent();
    setUploadStatus("已清除所有上傳的文獻。", false);
  }

  function initUploadPanel() {
    const input = $("#xml-upload-input");
    const dropzone = $("#upload-dropzone");

    input.addEventListener("change", () => {
      if (input.files.length) handleFiles(input.files);
      input.value = ""; // 讓同名檔案也能再次上傳
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dropzone-active");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dropzone-active");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    dropzone.addEventListener("click", () => input.click());

    $("#upload-reset").addEventListener("click", resetUploads);

    renderUploadPanel();
  }

  // ----------------------------------------------------------------
  // PMID 清單面板：讀取 .txt、抓 NCBI 全文/摘要，加入語料庫
  // ----------------------------------------------------------------
  function setPmidStatus(msg, isError) {
    const el = $("#pmid-status");
    el.textContent = msg;
    el.classList.toggle("upload-status-error", !!isError);
  }

  function initPmidPanel() {
    const input = $("#pmid-upload-input");
    const dropzone = $("#pmid-dropzone");
    const preview = $("#pmid-preview");
    const previewCount = $("#pmid-preview-count");
    const startBtn = $("#pmid-fetch-start");
    let pendingIds = { pmids: [], pmcIds: [] };

    function loadTxt(file) {
      if (!/\.txt$/i.test(file.name)) {
        setPmidStatus("請選擇 .txt 檔案。", true);
        return;
      }
      file.text().then((text) => {
        // Format 1: PubMed's own "Save → Format: Abstract" export — the
        // abstract text is already in the file, so this parses INSTANTLY
        // with zero network requests (no CORS risk at all).
        if (PubmedAbstractTxtParser.looksLikePubmedAbstractTxt(text)) {
          const result = PubmedAbstractTxtParser.parsePubmedAbstractTxt(text, "pubmed_txt");
          if (result.ok && result.docs.length) {
            let added = 0;
            result.docs.forEach((doc) => {
              doc.id = uniqueId(doc.id);
              UPLOADED_DOCS.push(doc);
              added++;
            });
            persistUploads();
            rebuildAll();
            renderUploadPanel();
            renderCorpusOverview();
            rerenderCurrent();
            preview.hidden = true;
            pendingIds = { pmids: [], pmcIds: [] };
            setPmidStatus(`偵測到 PubMed 摘要匯出格式，已直接解析並新增 ${added} 篇文獻。`, false);
            return;
          }
        }

        // Format 2/3: a list of bare PMIDs and/or "PMC..." accession
        // numbers (freely mixed) -> this DOES need a live fetch to NCBI,
        // so show a preview + explicit confirm step first.
        pendingIds = PmidFetcher.extractIds(text);
        const total = pendingIds.pmids.length + pendingIds.pmcIds.length;
        if (!total) {
          preview.hidden = true;
          setPmidStatus("這個檔案看起來不是 PubMed 摘要匯出格式，也沒有找到看起來像 PMID 或 PMC 編號的內容。", true);
          return;
        }
        const parts = [];
        if (pendingIds.pmids.length) parts.push(`${pendingIds.pmids.length} 個 PMID`);
        if (pendingIds.pmcIds.length) parts.push(`${pendingIds.pmcIds.length} 個 PMC 編號`);
        previewCount.textContent = `找到 ${parts.join("、")}，準備好就按下方按鈕開始。`;
        preview.hidden = false;
        setPmidStatus("", false);
      }).catch((e) => setPmidStatus("無法讀取檔案：" + e.message, true));
    }

    input.addEventListener("change", () => {
      if (input.files.length) loadTxt(input.files[0]);
      input.value = "";
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dropzone-active");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dropzone-active");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) loadTxt(e.dataTransfer.files[0]);
    });
    dropzone.addEventListener("click", () => input.click());

    startBtn.addEventListener("click", async () => {
      if (!pendingIds.pmids.length && !pendingIds.pmcIds.length) return;
      startBtn.disabled = true;
      try {
        const { docs, errors } = await PmidFetcher.fetchArticlesForIds(
          pendingIds,
          (msg) => setPmidStatus(msg, false)
        );

        let added = 0;
        docs.forEach((doc) => {
          doc.id = uniqueId(doc.id);
          UPLOADED_DOCS.push(doc);
          added++;
        });

        if (added > 0) {
          persistUploads();
          rebuildAll();
          renderUploadPanel();
          renderCorpusOverview();
          rerenderCurrent();
        }

        const parts = [];
        if (added) parts.push(`成功新增 ${added} 篇文獻`);
        if (errors.length) parts.push(`${errors.length} 個問題：${errors.join("；")}`);
        setPmidStatus(parts.join("。") || "沒有新增任何文獻。", errors.length > 0 && added === 0);
        setUploadStatus("", false); // 順便清掉「上傳 XML 文件」那邊可能殘留的舊狀態文字

        if (added > 0) {
          preview.hidden = true;
          pendingIds = { pmids: [], pmcIds: [] };
        }
      } catch (e) {
        setPmidStatus(e.message, true);
      } finally {
        startBtn.disabled = false;
      }
    });
  }

  // ----------------------------------------------------------------
  // 即時分析器：貼上任意文字，立即看到規則式統計結果
  // ----------------------------------------------------------------
  function initAnalyzer() {
    const input = $("#analyzer-input");
    const out = $("#analyzer-output");
    const sentList = $("#analyzer-sentences");

    function run() {
      const text = input.value;
      if (!text.trim()) {
        out.innerHTML = "";
        sentList.innerHTML = "";
        return;
      }
      const s = IRCore.computeStats(text);
      out.innerHTML = [
        ["字元數", s.num_characters],
        ["字數", s.num_words],
        ["句數", s.num_sentences],
        ["平均每句字數", s.avg_words_per_sentence],
        ["唯一詞幹數", s.num_unique_stems],
      ].map(([label, val]) => `<div class="stat-chip small"><span>${label}</span><strong>${val}</strong></div>`).join("");
      sentList.innerHTML = s.sentences.map((sent, i) =>
        `<li><span class="sent-idx">${i + 1}</span>${escapeHtml(sent)}</li>`).join("");
    }

    input.addEventListener("input", run);
    $("#analyzer-sample").addEventListener("click", () => {
      input.value = "Dr. Silva et al. reported a 9.7 mmHg reduction in systolic blood pressure (p < 0.001). This exceeded the 5.0 mmHg threshold set a priori. Is a low-sodium diet, e.g. <100 mmol/day, feasible long-term? Further trials, incl. larger cohorts, are planned for 2025.";
      run();
    });
  }

  // ----------------------------------------------------------------
  // 啟動
  // ----------------------------------------------------------------
  async function init() {
    const searchInput = $("#search-input");
    const form = $("#search-form");
    const modal = $("#doc-modal");

    // Wire up the upload panel and modal FIRST, independent of whether the
    // base corpus loads successfully — so "upload" still works even if
    // corpus.json failed to fetch (e.g. opened via file:// instead of a
    // server, or pushed without the data/ folder).
    loadUploadsFromStorage();
    initUploadPanel();
    initPmidPanel();
    $("#doc-modal-close").addEventListener("click", () => modal.close());
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.close();
    });
    initAnalyzer();

    try {
      await loadBaseCorpus();
    } catch (err) {
      BASE_DOCS = [];
      $("#results").innerHTML = `<p class="empty-state">無法載入內建語料庫（${escapeHtml(String(err))}）。這通常是因為直接用瀏覽器打開檔案（file://）而不是透過伺服器。請改用 <code>python3 -m http.server</code> 開一個本機伺服器，或部署到 GitHub Pages 後再開啟。上傳功能不受影響，仍可使用。</p>`;
    }

    rebuildAll();
    renderCorpusOverview();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      renderResults(searchInput.value);
    });
    //searchInput.addEventListener("input", () => renderResults(searchInput.value));

    const includeTitleToggle = $("#include-title-toggle");
    if (includeTitleToggle) {
      includeTitleToggle.addEventListener("change", () => {
        INCLUDE_TITLE = includeTitleToggle.checked;
        renderResults(searchInput.value);
      });
    }

    $$(".example-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        searchInput.value = chip.textContent;
        renderResults(searchInput.value);
        searchInput.focus();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
