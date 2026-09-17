# XML 全文檢索系統

這是我在資訊擷取技術課程中製作的 XML 全文檢索系統，採用 TF-IDF 加權向量空間模型與餘弦相似度進行搜尋結果排序，搭配規則式斷句、Porter 詞幹還原等經典 IR 前處理技術。

我將系統做成可以直接在瀏覽器執行的網頁，使用者可透過上傳 XML 文件、PMID 清單、或 PubMed 摘要匯出檔案等三種方式加入文獻，再透過關鍵字搜尋文件。

目前的實作包含前端搜尋介面、XML 解析、文字前處理、索引建立及搜尋結果排序，也另外整理了 Python 批次處理工具，方便建立預設的文獻語料庫。

**線上展示：** `https://deer140652.github.io/xml-fulltext-search/web/`

## 特色

- 瀏覽器端執行，不需要另外架設後端伺服器或資料庫。
- 可以手動上傳 XML 文件、PubMed 摘要清單.txt，或使用 PMID 清單.txt 抓取 PubMed 摘要。
- 自動辨識 JATS／PubMed 標準格式，擷取文章標題與摘要；其他 XML 則使用整份文字建立索引。
- 使用規則式斷句、Porter 詞幹還原及停用詞過濾進行文字前處理。
- 使用 TF-IDF 與餘弦相似度進行搜尋結果排序。
- 可以切換是否將文章標題納入搜尋，觀察不同索引範圍對結果的影響。

## 使用方式

系統提供以下幾種方式加入文件：

1. **上傳 XML 文件**  
   直接選擇本機的 XML 檔案，系統會解析內容並建立搜尋索引。

2. **使用 PMID 清單抓取文獻**  
   上傳 PMID 清單後，系統會嘗試從 NCBI PubMed API 取得文章摘要。

3. **上傳 PubMed 摘要匯出檔**  
   可以先在本機取得 PubMed 摘要，再透過網頁上傳使用。

如果 XML 符合 JATS／PubMed 常見格式，系統會擷取文章標題與摘要；如果無法辨識標準格式，則會改用整份 XML 文字建立索引。

## 專案結構

```
xml-fulltext-search/
├── web/                      網頁前端
  ├── index.html
  ├── assets/js/              搜尋與文字處理相關程式
  ├── assets/css/
  └── data/                   語料庫索引 JSON

├── scripts/                  Python 批次處理工具
  ├── ir_core.py              與瀏覽器端邏輯對應的 Python 版本
  ├── build_index.py          建立 XML 語料庫索引
  └── fetch_by_pmid_list.py   本機端抓取 PMID 對應摘要 （瀏覽器抓取失敗時的備援）

├── backend/
  └── ncbi-proxy-worker.js    NCBI API 代理

├── data/raw_pmc/             放置要批次處理的 XML 文件
└── README.md
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

## PMID 自動抓取與 CORS

「使用 PMID 清單抓取文獻」功能會讓瀏覽器向 NCBI 的 `efetch` API 發送請求。由於瀏覽器可能受到 CORS 政策限制，直接連線不一定每次都能成功。

目前系統會依序嘗試：

1. 直接連線 NCBI API。
2. 使用 `backend/ncbi-proxy-worker.js`，透過部署在 Cloudflare Workers 的代理轉送請求。
3. 使用公開的免費 CORS 代理服務。

如果以上方式都無法取得資料，可以改用：

```bash
python3 scripts/fetch_by_pmid_list.py PMID清單.txt
```

先在本機下載 PMID 對應的摘要，再透過網頁的「上傳 XML 文件」功能加入系統。


