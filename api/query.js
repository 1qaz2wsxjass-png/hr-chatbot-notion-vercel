// 引入所需的函式庫
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 設定區 ---
const { NOTION_API_KEY, KNOWLEDGE_BASE_ID, LOG_DB_ID, GEMINI_API_KEY } = process.env;

// Notion API 的基本設定
const NOTION_API_URL = "https://api.notion.com/v1";
const notion = axios.create({
  baseURL: NOTION_API_URL,
  headers: {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  },
});

// Gemini AI 的基本設定
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-05-20" });

// --- 快取設定 (Caching) ---
// 建立一個記憶體內快取來儲存知識庫
let cache = {
  qaPairs: null,
  lastFetchTime: 0
};
// 快取過期時間 (毫秒)：10 分鐘
const CACHE_TTL_MS = 10 * 60 * 1000; 


// --- Notion 資料庫相關函式 ---

// 1. 取得知識庫中所有的 Q&A 列表 (原始函式)
const fetchAllQAPairs = async () => {
  let allItems = [];
  let hasMore = true;
  let startCursor = undefined;
  
  try {
    while (hasMore) {
      const response = await notion.post(`/databases/${KNOWLEDGE_BASE_ID}/query`, {
        start_cursor: startCursor,
        page_size: 100,
        filter: {
            property: "Question",
            title: { is_not_empty: true }
        }
      });
      
      const results = response.data.results;
      results.forEach(page => {
        const properties = page.properties;
        const questionText = properties.Question?.title[0]?.plain_text;
        if (questionText) {
          allItems.push({
            question: questionText.trim(),
            answer: properties.Answer?.rich_text.map(t => t.plain_text).join('') || "",
            imageUrl: properties.Image_URL?.url || null,
            pdfUrl: properties.PDF_URL?.url || null,
            linkUrl: properties.Link_URL?.url || null,
            linkText: properties.Link_Text?.rich_text.map(t => t.plain_text).join('') || null
          });
        }
      });
      
      hasMore = response.data.has_more;
      startCursor = response.data.next_cursor;
    }
    console.log(`成功從 Notion 讀取 ${allItems.length} 筆 Q&A。`);
    return allItems;
  } catch (error) {
    console.error("讀取所有 Notion Q&A 時出錯:", error.response ? error.response.data : error.message);
    return [];
  }
};

// 2. 新增：取得知識庫 (從快取或 Notion)
const getKnowledgeBase = async () => {
  const now = Date.now();
  // 檢查快取是否存在且未過期
  if (cache.qaPairs && (now - cache.lastFetchTime < CACHE_TTL_MS)) {
    console.log("從快取中讀取知識庫。");
    return cache.qaPairs;
  }

  // 快取過期或不存在，從 Notion 重新擷取
  console.log("快取過期或不存在，從 Notion 重新擷取。");
  const allQAPairs = await fetchAllQAPairs();
  if (allQAPairs.length > 0) {
    // 更新快取
    cache.qaPairs = allQAPairs;
    cache.lastFetchTime = now;
  }
  return allQAPairs;
};


// --- Gemini AI 相關函式 (保留「雙軌回覆模式」的邏輯) ---
const findMatchesWithGemini = async (userQuestion, allQAPairs) => {
  // AI 會讀取完整的「問題」和「答案」
  const knowledgeBaseText = allQAPairs.map(item => `[問題開始]\n${item.question}\n[答案開始]\n${item.answer}\n[項目結束]`).join('\n\n');
  const allQuestions = allQAPairs.map(item => item.question);

  const prompt = `
    您是一個知識庫搜尋專家。請分析以下使用者問題和知識庫。
    您的任務分兩步：
    1.  首先，判斷知識庫中有沒有一個問題，其語意與使用者問題「幾乎完全相同」或能「直接回答」。如果有，請回傳 "EXACT_MATCH::" 加上那個最精準的「原始問題」。
    2.  如果沒有完全相同的問題，請找出知識庫中與使用者問題語意「所有相關」的項目，並回傳 "RELATED_MATCH::" 加上所有匹配的「原始問題」，並用 "|||" 分隔。
    3.  如果找不到任何相關項目，請回傳 "NO_MATCH"。

    [知識庫開始]
    ${knowledgeBaseText}
    [知識庫結束]

    使用者問題：「${userQuestion}」
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let rawResponse = response.text().trim();

    if (rawResponse.startsWith("EXACT_MATCH::")) {
      const question = rawResponse.replace("EXACT_MATCH::", "").trim();
      // 驗證 AI 回傳的問題是否真的存在於列表中
      if (allQuestions.includes(question)) {
        console.log(`Gemini 找到精準匹配: ${question}`);
        return { type: 'exact', questions: [question] };
      }
    }
    
    if (rawResponse.startsWith("RELATED_MATCH::")) {
      const questionsText = rawResponse.replace("RELATED_MATCH::", "").trim();
      const matchedQuestions = questionsText.split("|||").map(q => q.trim()).filter(q => allQuestions.includes(q));
      if (matchedQuestions.length > 0) {
        console.log(`Gemini 找到 ${matchedQuestions.length} 個相關匹配: ${matchedQuestions.join(", ")}`);
        return { type: 'related', questions: matchedQuestions };
      }
    }

    console.log("Gemini 無法找到匹配，或回傳格式不符。");
    return { type: 'none', questions: [] };
  } catch (error) {
    console.error("使用 Gemini 匹配時失敗:", error);
    return { type: 'none', questions: [] };
  }
};


// --- 日誌記錄函式 ---
const logQuery = async (question, foundAnswer, matchedQuestion) => {
  if (!LOG_DB_ID) return; // 如果沒有設定日誌 ID，就略過
  try {
    await notion.post("/pages", {
      parent: { database_id: LOG_DB_ID },
      properties: {
        "Query": { title: [{ text: { content: question } }] },
        "Found Answer": { checkbox: foundAnswer },
        "Matched Keywords": { rich_text: [{ text: { content: `語意匹配: ${matchedQuestion}` } }] },
      },
    });
  } catch (error) {
    // 即使日誌記錄失敗，也不要影響主流程
    console.error("記錄日誌失敗:", error.response ? error.response.data : error.message);
  }
};


// --- Vercel Serverless Function 主體 (已加入快取) ---
module.exports = async (req, res) => {
  // 允許跨域請求 (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*'); // 允許所有來源
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 處理 CORS 預檢請求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只接受 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "僅允許 POST 請求" });
  }

  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: "請提供問題。" });
  }

  try {
    // 1. 優化：從快取或 Notion 取得知識庫
    const allQAPairs = await getKnowledgeBase(); // <--- 使用快取函式
    if (allQAPairs.length === 0) {
      return res.status(200).json({ answer: "抱歉，知識庫目前是空的，我無法回答任何問題。" });
    }

    // 2. AI 讀取完整的 Q&A 列表進行比對
    const matchResult = await findMatchesWithGemini(question, allQAPairs);

    // 3. 根據 AI 回傳的「問題字串」，從完整的 Q&A 列表中找出答案
    if (matchResult.type === 'exact' && matchResult.questions.length > 0) {
      // --- 精準回覆模式 ---
      const matchedItem = allQAPairs.find(item => item.question === matchResult.questions[0]);
      await logQuery(question, true, `精準匹配: ${matchedItem.question}`);
      return res.status(200).json({ ...matchedItem, ai_assisted: true });

    } else if (matchResult.type === 'related' && matchResult.questions.length > 0) {
      // --- 智慧整合模式 ---
      const matchedItems = allQAPairs.filter(item => matchResult.questions.includes(item.question));
      
      let combinedAnswer = "關於您的問題，我找到了以下幾點相關規定：\n\n";
      let combinedImageUrl = null, combinedPdfUrl = null, combinedLinkUrl = null, combinedLinkText = null;

      matchedItems.forEach((item, index) => {
        combinedAnswer += `• **${item.question}**\n${item.answer}\n\n`;
        // 只使用第一個匹配項的附件，保持介面簡潔
        if (index === 0) {
            combinedImageUrl = item.imageUrl;
            combinedPdfUrl = item.pdfUrl;
            combinedLinkUrl = item.linkUrl;
            combinedLinkText = item.linkText;
        }
      });

      await logQuery(question, true, `相關匹配: ${matchResult.questions.join(" | ")}`);
      return res.status(200).json({ 
          answer: combinedAnswer.trim(),
          imageUrl: combinedImageUrl,
          pdfUrl: combinedPdfUrl,
          linkUrl: combinedLinkUrl,
          linkText: combinedLinkText,
          ai_assisted: true 
      });
    }

    // --- 找不到答案 ---
    await logQuery(question, false, "無匹配");
    res.status(200).json({
      answer: "抱歉，我在知識庫中找不到與您問題直接相關的答案。您可以試著換個問法。",
      ai_assisted: true,
    });

  } catch (error) {
    console.error("伺服器內部錯誤:", error);
    res.status(500).json({ error: "處理您的請求時發生內部錯誤。" });
  }
}
