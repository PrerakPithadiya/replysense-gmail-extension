// Background service worker: receives requests from the content script to generate a reply.
// It reads apiBase, apiKey, and model from chrome.storage and calls the configured Gemini endpoint.
// IMPORTANT: Do NOT hardcode your API key. Put it in the extension popup (chrome.storage.local).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "GENERATE_REPLY") {
    // message.payload: { prompt: string, maxTokens?: number }
    generateReply(message.payload).then((result) => {
      sendResponse({ ok: true, text: result });
    }).catch((err) => {
      // Improved error handling
      const errorMessage = err && err.message ? err.message : (typeof err === 'string' ? err : String(err));
      console.error("Gmail Reply Generator: Generate error:", errorMessage, err);
      sendResponse({ ok: false, error: errorMessage });
    });
    // Indicate async response
    return true;
  }
});

// Generic generator — uses user-configured apiBase and apiKey from storage.
// We purposely keep request structure generic — adjust to your Gemini endpoint format if needed.
async function generateReply(payload) {
  const stored = await chrome.storage.local.get(["apiBase", "apiKey", "model", "maxTokens"]);
  const apiBase = (stored.apiBase || "").trim();
  const apiKey = (stored.apiKey || "").trim();
  const model = stored.model || "gemini-2.5-pro";
  const maxTokens = stored.maxTokens || 4096;

  // Better validation with specific messages
  if (!apiBase) {
    console.error("Gmail Reply Generator: API base URL is missing");
    throw new Error("API base URL not set. Click the extension icon and configure it in the popup.");
  }
  if (!apiKey) {
    console.error("Gmail Reply Generator: API key is missing");
    throw new Error("API key not set. Click the extension icon and configure it in the popup.");
  }
  
  if (!payload || !payload.prompt) {
    console.error("Gmail Reply Generator: Invalid payload - prompt is missing");
    throw new Error("Invalid request: prompt is required.");
  }

  console.log("Gmail Reply Generator: Generating reply with model:", model, "maxTokens:", maxTokens);

  // Assemble endpoint URL.
  // Detect if this is Google's official Gemini API (generativelanguage.googleapis.com)
  const isGoogleGemini = apiBase.includes("generativelanguage.googleapis.com");
  
  let url, body, headers;
  
  if (isGoogleGemini) {
    // Google Gemini API format with system instruction support
    const base = apiBase.replace(/\/$/, "");
    url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    
    // Check if prompt is an object with systemInstruction and userPrompt
    // (new format) or just a string (old format for compatibility)
    let systemInstruction = null;
    let userPrompt = payload.prompt;
    
    if (typeof payload.prompt === 'object' && payload.prompt.systemInstruction && payload.prompt.userPrompt) {
      systemInstruction = payload.prompt.systemInstruction;
      userPrompt = payload.prompt.userPrompt;
    }
    
    body = {
      contents: [{
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        maxOutputTokens: maxTokens
      }
    };
    
    // Add system instruction if provided (supported in Gemini 1.5+ and 2.0+)
    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction }]
      };
    }
    
    headers = {
      "Content-Type": "application/json"
    };
  } else {
    // Generic/other provider format
    const base = apiBase.replace(/\/$/, "");
    url = `${base}/models/${encodeURIComponent(model)}:generate`;
    body = {
      prompt: payload.prompt,
      max_output_tokens: maxTokens
    };
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
  }

  console.log("Gmail Reply Generator: Making request to:", url);
  
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });
  } catch (fetchError) {
    // "Failed to fetch" usually means CORS, network, or wrong URL
    console.error("Gmail Reply Generator: Fetch failed:", fetchError);
    const errorMsg = fetchError.message || String(fetchError);
    if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError")) {
      throw new Error(`Cannot connect to API. Check:\n1. API Base URL is correct: ${apiBase}\n2. You have internet connection\n3. The API endpoint allows requests from browser extensions\n\nFull error: ${errorMsg}`);
    }
    throw fetchError;
  }

  if (!res.ok) {
    const text = await res.text();
    console.error("Gmail Reply Generator: API error response:", res.status, text);
    
    // Try to parse error JSON for better error messages
    let errorMessage = `API returned ${res.status}`;
    try {
      const errorJson = JSON.parse(text);
      if (errorJson.error && errorJson.error.message) {
        errorMessage = errorJson.error.message;
        // If it's a model not found error, provide helpful suggestion
        if (errorMessage.includes("is not found") || errorMessage.includes("not supported")) {
          errorMessage += `\n\nTry using "gemini-1.5-pro" or "gemini-1.5-flash" instead. Update the model in the extension popup settings.`;
        }
      } else if (errorJson.error) {
        errorMessage = JSON.stringify(errorJson.error);
      }
    } catch (e) {
      // If JSON parsing fails, use the raw text
      errorMessage = text.substring(0, 300);
    }
    
    throw new Error(errorMessage);
  }

  // Parse response — we try a few common shapes so the extension works with multiple Gemini setups.
  const json = await res.json();
  console.log("Gmail Reply Generator: Full API response:", JSON.stringify(json, null, 2));

  // Google Gemini API format: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (json.candidates && Array.isArray(json.candidates) && json.candidates[0]) {
    const candidate = json.candidates[0];
    
    // Extract text from parts array first (even if truncated)
    if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts)) {
      // Combine all text parts (in case there are multiple)
      const textParts = candidate.content.parts
        .filter(part => part && part.text)
        .map(part => part.text)
        .join("");
      
      if (textParts) {
        // If it was truncated, add a note but still return the text
        if (candidate.finishReason === "MAX_TOKENS") {
          console.warn("Gmail Reply Generator: Response was truncated. Consider increasing maxTokens.");
          return textParts + "\n\n[Response was truncated. Increase maxTokens in settings for full reply.]";
        }
        return textParts;
      }
    }
    
    // Fallback: check if content is directly a string
    if (candidate.content && typeof candidate.content === 'string') {
      return candidate.content;
    }
    
    // If we have a finishReason but no text, check usage metadata for details
    if (candidate.finishReason === "MAX_TOKENS") {
      const usage = json.usageMetadata;
      const details = usage ? `Prompt: ${usage.promptTokenCount || 0} tokens, Thinking: ${usage.thoughtsTokenCount || 0} tokens, Total: ${usage.totalTokenCount || 0} tokens` : "";
      throw new Error(`Response hit token limit (${maxTokens}). ${details}\n\nTry increasing maxTokens to 4096 or higher in extension settings.`);
    }
    
    // Other finish reasons
    if (candidate.finishReason) {
      throw new Error(`Response finished with reason: ${candidate.finishReason}. No text was generated.`);
    }
  }
  
  // Other possible shapes:
  // - { output: [{ content: "..." }] }
  // - { text: "..." }
  // - { generations: [{ text: "..." }] }
  if (json.output && Array.isArray(json.output) && json.output[0].content) {
    return json.output[0].content;
  }
  if (json.text) {
    return json.text;
  }
  if (json.generations && Array.isArray(json.generations) && json.generations[0].text) {
    return json.generations[0].text;
  }

  // Fallback: if we got here, the response format is unexpected
  console.error("Gmail Reply Generator: Unexpected response format. Full response:", JSON.stringify(json, null, 2));
  
  // Try to extract any text we can find in the response
  const responseStr = JSON.stringify(json);
  if (responseStr.includes('"text"')) {
    // Try to find text field anywhere in the response
    const textMatch = responseStr.match(/"text"\s*:\s*"([^"]+)"/);
    if (textMatch && textMatch[1]) {
      return textMatch[1];
    }
  }
  
  throw new Error(`Could not extract reply text from API response. Response format may have changed. Check the browser console for the full response.`);
}
