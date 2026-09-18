# XML 全文檢索系統

這是我在資訊擷取技術課程中製作的 XML 全文檢索系統，採用 TF-IDF 加權向量空間模型與餘弦相似度進行搜尋結果排序，搭配規則式斷句、Porter 詞幹還原等經典 IR 前處理技術。

我將系統做成可以直接在瀏覽器執行的網頁，使用者可透過上傳 XML 文件、文獻識別碼清單（PMID / PMCID）或 PubMed 摘要匯出檔案等三種方式加入文獻，再透過關鍵字搜尋文件。

目前的實作包含前端搜尋介面、XML 解析、文字前處理、索引建立及搜尋結果排序，也另外整理了 Python 批次處理工具，方便建立預設的文獻語料庫。

**線上展示：** `https://deer140652.github.io/xml-fulltext-search/web/`

## 特色

- 瀏覽器端執行，不需要另外架設後端伺服器或資料庫。
- 支援上傳本機 XML 文件、PubMed 摘要匯出檔或文獻識別碼清單（PMID / PMCID）自動抓取文獻資料。。
- 自動辨識 JATS / PubMed 標準格式，擷取文章標題與摘要；其他 XML 則使用整份文字建立索引。
- 使用規則式斷句、Porter 詞幹還原及停用詞過濾進行文字前處理。
- 使用 TF-IDF 與餘弦相似度進行搜尋結果排序。
- 可以切換是否將文章標題納入搜尋，觀察不同索引範圍對結果的影響。

## 使用方式

系統提供以下幾種方式加入文件：

1. **上傳 XML 文件**  
   直接選擇本機的 XML 檔案，系統會解析內容並建立搜尋索引。

2. **使用文獻識別碼清單（PMID / PMCID）抓取文獻**  
   上傳清單後，系統會透過 NCBI E-utilities 取得對應文獻的摘要或全文。

3. **上傳 PubMed 摘要匯出檔**  
   上傳由 PubMed 匯出的摘要檔案，系統會解析內容並建立搜尋索引。

若 XML 符合標準 JATS / PubMed 格式（含透過 PMCID 抓取之全文檔），系統考量瀏覽器端計算效能，會優先擷取文章標題與摘要進行索引與展示；若為其他無法辨識標準格式的 XML，則會直接使用整份文字建立索引。

## 專案結構

```text
web/                      網頁前端
  index.html              搜尋系統主頁面
  assets/js/              搜尋與文字處理相關程式
  assets/css/             網頁樣式（UI 排版與風格）
  data/                   語料庫索引 JSON

scripts/                  Python 批次處理工具
  ir_core.py              與瀏覽器端邏輯對應的 Python 版本
  build_index.py          建立 XML 語料庫索引
  fetch_by_pmid_list.py   本機端依 PMID 抓取摘要 XML 工具
  fetch_pmc_articles.py   本機端依 PMCID 抓取全文 XML 工具

backend/
  ncbi-proxy-worker.js    NCBI API 代理

data/raw_pmc/             放置要批次處理的 XML 文件
```

## 主要技術

- HTML、CSS、JavaScript
- Python
- XML 解析
- 規則式斷句
- Porter 詞幹還原
- 停用詞過濾
- TF-IDF
- 向量空間模型
- 餘弦相似度
- Cloudflare Workers

## 檢索流程

```text
XML 文件
   ↓
擷取標題、摘要或全文文字
   ↓
文字前處理
   ├─ 規則式斷句
   ├─ 詞幹還原
   └─ 停用詞過濾
   ↓
建立 TF-IDF 索引
   ↓
輸入搜尋關鍵字
   ↓
計算餘弦相似度
   ↓
依相似度排序搜尋結果
```

## 離線批次建立語料庫（選用）

如果希望網站開啟時就有一批預設文獻，而不是每次都手動上傳，可以使用 Python 工具先建立語料庫。

先將 XML 檔案放入：

```text
data/raw_pmc/
```

再執行：

```bash
python3 scripts/build_index.py
```

執行完成後，會產生：

```text
web/data/corpus.json
web/data/index.json
```

之後開啟網站時，就可以直接使用這批預設文獻進行搜尋。

## 文獻識別碼自動抓取與 CORS

使用文獻識別碼清單（PMID / PMCID）抓取文獻功能會讓瀏覽器向 NCBI 的 efetch API 發送請求。由於瀏覽器可能受到 CORS 政策限制，直接連線不一定每次都能成功。

目前系統會依序嘗試：

1. 直接連線 NCBI API。
2. 使用 `backend/ncbi-proxy-worker.js`，透過部署在 Cloudflare Workers 的代理轉送請求。
3. 使用公開的免費 CORS 代理服務。

如果以上方式都無法取得資料，可以改用本機 Python 工具下載後再匯入：

**抓取 PMID 摘要（支援清單文字檔）**：
```bash
python3 scripts/fetch_by_pmid_list.py PMID清單.txt
```
**抓取 PMCID 全文（支援直接帶入 ID 參數）**：
```bash
python3 scripts/fetch_pmc_articles.py PMC7096066 PMC8425720
```

先在本機下載對應的摘要或全文 XML，再透過網頁的「上傳 XML 文件」功能加入系統。


