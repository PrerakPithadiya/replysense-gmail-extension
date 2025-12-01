/*
Content script:
- Injects Toggle + Generate buttons into Gmail message toolbar (when an email is opened).
- Uses MutationObserver to detect opened email view.
- Stores per-thread enabled/disabled state in chrome.storage.local with key "threadEnabled:{threadId}"
- When Generate is pressed, extracts the original email body, sends it to background to create a reply,
  then inserts the reply into Gmail's reply editor.
*/

(function () {
  console.log("Gmail Reply Generator content script loaded.");

  const BUTTON_CONTAINER_ID = "grg-button-container";
  const LOGS_STORAGE_KEY = "grg_logs";
  const MAX_LOGS = 1000; // Maximum number of logs to keep  

  // Helper function to check if extension context is valid
  function isExtensionContextValid() {
    try {
      // Try to access chrome.runtime.id - if it throws, context is invalid
      if (!chrome || !chrome.runtime) {
        return false;
      }
      // Accessing chrome.runtime.id will throw if context is invalidated
      const id = chrome.runtime.id;
      return id !== undefined;
    } catch (e) {
      // Context is invalid if accessing runtime.id throws
      return false;
    }
  }
  
  // Check if an error is related to invalidated extension context
  function isContextInvalidatedError(error) {
    if (!error) return false;
    const errorMsg = error.message || String(error) || '';
    return errorMsg.includes('Extension context invalidated') || 
           errorMsg.includes('message port closed') ||
           errorMsg.includes('Receiving end does not exist');
  }

  // Safe wrapper for chrome.storage.local.get
  function safeStorageGet(keys, callback) {
    if (!isExtensionContextValid()) {
      console.warn("Extension context invalidated - cannot access storage");
      if (callback) callback({});
      return Promise.resolve({});
    }
    
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            // Check if it's a context invalidated error
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.warn("Extension context invalidated during storage get");
            } else {
              console.error("Storage get error:", errorMsg);
            }
            resolve({});
            if (callback) callback({});
            return;
          }
          resolve(result);
          if (callback) callback(result);
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          console.warn("Extension context invalidated - storage get failed");
        } else {
          console.error("Storage get exception:", error);
        }
        resolve({});
        if (callback) callback({});
      }
    });
  }

  // Safe wrapper for chrome.storage.local.set
  function safeStorageSet(data, callback) {
    if (!isExtensionContextValid()) {
      console.warn("Extension context invalidated - cannot save to storage");
      if (callback) callback();
      return Promise.resolve();
    }
    
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(data, () => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            // Check if it's a context invalidated error
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.warn("Extension context invalidated during storage set");
            } else {
              console.error("Storage set error:", errorMsg);
            }
          }
          resolve();
          if (callback) callback();
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          console.warn("Extension context invalidated - storage set failed");
        } else {
          console.error("Storage set exception:", error);
        }
        resolve();
        if (callback) callback();
      }
    });
  }

  // Safe wrapper for chrome.runtime.sendMessage
  function safeSendMessage(message, callback) {
    if (!isExtensionContextValid()) {
      console.warn("Extension context invalidated - cannot send message");
      if (callback) callback({ ok: false, error: "Extension context invalidated. Please reload the page." });
      return;
    }
    
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message;
          console.error("Message send error:", errorMsg);
          if (callback) callback({ ok: false, error: errorMsg });
          return;
        }
        if (callback) callback(response);
      });
    } catch (error) {
      console.error("Message send exception:", error);
      if (callback) callback({ ok: false, error: error.message || "Failed to send message" });
    }
  }

  // Logging utility functions
  async function addLog(type, action, details = {}) {
    // Check context validity before starting
    if (!isExtensionContextValid()) {
      console.warn("Extension context invalidated - cannot log");
      return;
    }
    
    try {
      const logEntry = {
        id: Date.now() + Math.random(), // Unique ID
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        type: type, // 'extension' or 'reply'
        action: action, // 'enabled', 'disabled', 'generated', 'accepted', 'rejected'
        details: details
      };

      // Check again before storage operations (context might have been invalidated)
      if (!isExtensionContextValid()) {
        console.warn("Extension context invalidated - skipping log");
        return;
      }

      // Get existing logs
      const result = await safeStorageGet([LOGS_STORAGE_KEY]);
      
      // Check context again after async operation
      if (!isExtensionContextValid()) {
        console.warn("Extension context invalidated after storage get - skipping log");
        return;
      }
      
      const logs = result[LOGS_STORAGE_KEY] || [];

      // Add new log at the beginning (most recent first)
      logs.unshift(logEntry);

      // Keep only the most recent MAX_LOGS entries
      if (logs.length > MAX_LOGS) {
        logs.splice(MAX_LOGS);
      }

      // Check context before saving
      if (!isExtensionContextValid()) {
        console.warn("Extension context invalidated before storage set - skipping log");
        return;
      }

      // Save back to storage
      await safeStorageSet({ [LOGS_STORAGE_KEY]: logs });
      
      console.log("Log added:", logEntry);
    } catch (error) {
      // Silently handle context invalidated errors - they're expected when extension reloads
      if (isContextInvalidatedError(error)) {
        console.warn("Extension context invalidated - log operation cancelled");
      } else {
        console.error("Failed to add log:", error);
      }
    }
  }

  // Utility: attempt multiple selectors to find elements.
  function queryAny(selectors, root = document) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // Detect the conversation/thread id using Gmail URL or data attributes
  function getThreadIdFromUrl() {
    // Gmail conversation URLs often contain "#inbox/FMfcgx..." or "/mail/u/0/#inbox/THREAD_ID"
    const m = location.href.match(/#.*\/([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
    // Fallback: use a stable substring of URL
    return location.href;
  }

  // Check if we're viewing an email (not just inbox list)
  function isEmailView() {
    // Check URL first - if it has a thread ID, we're viewing an email
    const hasThreadId = location.href.match(/#.*\/([A-Za-z0-9_-]{10,})/);
    if (hasThreadId) {
      return true;
    }
    
    // Check if we're in a conversation/email view (not inbox list)
    // Gmail shows email content in these containers
    const emailContentSelectors = [
      "div[role='main'] div[role='article']",  // Email content area
      "div[data-thread-perm-id]",              // Thread container
      ".nH.if",                                // Email view container
      "div[aria-label*='Conversation']",       // Conversation view
      "div[data-message-id]",                  // Message container
      "div[role='listitem'][data-thread-id]",  // Thread list item
      "div[data-legacy-thread-id]"             // Legacy thread ID
    ];
    
    const found = queryAny(emailContentSelectors) !== null;
    
    // Debug logging
    if (found) {
      console.log("Gmail Reply Generator: Email view detected");
    }
    
    return found;
  }

  // Find the toolbar where reply/forward buttons live
  function findToolbar() {
    // First, try to find the Reply/Forward button area in email view
    // This is more reliable than generic toolbars
    const replyForwardSelectors = [
      "div[aria-label='Reply']",                // Reply button
      "div[aria-label='Forward']",              // Forward button
      "div[aria-label='Reply all']",            // Reply all button
      "div[data-tooltip='Reply']",               // Reply tooltip
      "div[data-tooltip='Forward']",            // Forward tooltip
      "div[data-tooltip='Reply all']",          // Reply all tooltip
      "div[role='button'][aria-label*='Reply']", // Reply button role
      "div[role='button'][aria-label*='Forward']", // Forward button role
      "div[jsaction*='reply']",                  // Reply button with jsaction
      "div[jsaction*='forward']"                 // Forward button with jsaction
    ];
    
    const replyButton = queryAny(replyForwardSelectors);
    if (replyButton) {
      // Find the parent container that holds Reply/Forward buttons
      let parent = replyButton.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        // Look for a container with multiple buttons (Reply, Forward, etc.)
        const buttons = parent.querySelectorAll("div[role='button'], button, div[aria-label], div[data-tooltip]");
        if (buttons.length >= 2) {
          console.log("Gmail Reply Generator: Found toolbar via reply button parent");
          return parent;
        }
        parent = parent.parentElement;
      }
      // Fallback: return the parent of reply button
      console.log("Gmail Reply Generator: Using reply button parent as toolbar");
      return replyButton.parentElement;
    }
    
    // Fallback: try generic toolbar selectors
    const genericSelectors = [
      "div[data-tooltip='More']",
      "div[aria-label='More actions']",
      "div[aria-label='Message actions']",
      "div[role='toolbar']",
      "div[data-thread-perm-id] ~ div[role='toolbar']", // Toolbar near thread
      "div[data-thread-perm-id] + div",                 // Sibling of thread
      "div[role='main'] div[role='toolbar']"            // Toolbar in main area
    ];
    
    const toolbar = queryAny(genericSelectors);
    if (toolbar) {
      console.log("Gmail Reply Generator: Found toolbar via generic selectors");
    }
    return toolbar || null;
  }

  // Track current thread ID to detect when it changes
  let currentThreadId = null;

  // Create our UI container and buttons
  function createButtons() {
    // Only create buttons when viewing an email, not in inbox list
    if (!isEmailView()) {
      // Remove buttons if they exist in inbox view
      const existingContainer = document.getElementById(BUTTON_CONTAINER_ID);
      if (existingContainer) {
        existingContainer.remove();
      }
      return;
    }
    
    const newThreadId = getThreadIdFromUrl();
    
    // If thread ID changed, remove old buttons and recreate
    if (currentThreadId !== null && currentThreadId !== newThreadId) {
      const existingContainer = document.getElementById(BUTTON_CONTAINER_ID);
      if (existingContainer) {
        existingContainer.remove();
      }
    }
    
    // Don't re-create if exists and thread ID hasn't changed
    if (document.getElementById(BUTTON_CONTAINER_ID)) {
      // Update button state for current thread
      updateButtonState();
      return;
    }
    
    currentThreadId = newThreadId;

    console.log("Gmail Reply Generator: Creating buttons for thread:", newThreadId);

    // Try to find a visible toolbar near the opened message
    const toolbar = findToolbar();
    const container = document.createElement("div");
    container.id = BUTTON_CONTAINER_ID;
    container.style.cssText = `
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: 8px;
      z-index: 1000;
      position: relative;
    `;

    // Toggle button
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "grg-toggle-btn";
    toggleBtn.innerText = "Enable Extension";
    toggleBtn.style.cssText = `
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #888;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: #333;
    `;
    toggleBtn.addEventListener("mouseenter", () => {
      toggleBtn.style.background = "#f5f5f5";
    });
    toggleBtn.addEventListener("mouseleave", () => {
      toggleBtn.style.background = "#fff";
    });

    // Generate button
    const genBtn = document.createElement("button");
    genBtn.id = "grg-generate-btn";
    genBtn.innerText = "Generate Reply";
    genBtn.style.cssText = `
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #1a73e8;
      background: #1a73e8;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    `;
    genBtn.addEventListener("mouseenter", () => {
      genBtn.style.background = "#1557b0";
    });
    genBtn.addEventListener("mouseleave", () => {
      genBtn.style.background = "#1a73e8";
    });

    // View Logs button
    const logsBtn = document.createElement("button");
    logsBtn.id = "grg-logs-btn";
    logsBtn.innerText = "View Logs";
    logsBtn.style.cssText = `
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #666;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: #333;
    `;
    logsBtn.addEventListener("mouseenter", () => {
      logsBtn.style.background = "#f5f5f5";
    });
    logsBtn.addEventListener("mouseleave", () => {
      logsBtn.style.background = "#fff";
    });
    logsBtn.addEventListener("click", showLogsModal);

    container.appendChild(toggleBtn);
    container.appendChild(genBtn);
    container.appendChild(logsBtn);

    // Try multiple insertion strategies
    let inserted = false;

    // Strategy 1: Attach to toolbar if found
    if (toolbar) {
      if (toolbar.parentElement) {
        // Try to insert as a sibling next to the toolbar (after it)
        try {
          toolbar.parentElement.insertBefore(container, toolbar.nextSibling);
          inserted = true;
          console.log("Gmail Reply Generator: Buttons inserted next to toolbar");
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert next to toolbar:", e);
        }
      }
      
      if (!inserted) {
        // Insert after the toolbar
        try {
          toolbar.insertAdjacentElement("afterend", container);
          inserted = true;
          console.log("Gmail Reply Generator: Buttons inserted after toolbar");
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert after toolbar:", e);
        }
      }
    }

    // Strategy 2: Find email header and insert there
    if (!inserted) {
      const emailHeaderSelectors = [
        "div[data-thread-perm-id]",
        "div[role='main'] div[role='article']",
        ".nH.if",
        "div[data-message-id]",
        "div[role='listitem'][data-thread-id]"
      ];
      
      const emailHeader = queryAny(emailHeaderSelectors);
      if (emailHeader) {
        if (emailHeader.parentElement) {
          try {
            // Try to insert before the email header
            emailHeader.parentElement.insertBefore(container, emailHeader);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted before email header");
          } catch (e) {
            console.warn("Gmail Reply Generator: Failed to insert before email header:", e);
          }
        }
        
        if (!inserted) {
          try {
            // Try to insert as first child of email header
            emailHeader.insertBefore(container, emailHeader.firstChild);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted as first child of email header");
          } catch (e) {
            console.warn("Gmail Reply Generator: Failed to insert as first child:", e);
          }
        }
      }
    }

    // Strategy 3: Find the first message in conversation and insert near it
    if (!inserted) {
      const messageSelectors = [
        "div[role='listitem']",
        "div[data-message-id]",
        "div[role='article']"
      ];
      
      for (const selector of messageSelectors) {
        const message = document.querySelector(selector);
        if (message && message.parentElement) {
          try {
            message.parentElement.insertBefore(container, message);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted before first message");
            break;
          } catch (e) {
            // Continue to next selector
          }
        }
      }
    }

    // Strategy 4: Last resort - top of main content area
    if (!inserted) {
      const mainContent = document.querySelector("div[role='main']");
      if (mainContent) {
        try {
          mainContent.insertBefore(container, mainContent.firstChild);
          inserted = true;
          console.log("Gmail Reply Generator: Buttons inserted at top of main content");
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert in main content:", e);
        }
      }
    }

    // Final fallback
    if (!inserted) {
      try {
        document.body.appendChild(container);
        console.log("Gmail Reply Generator: Buttons inserted in body (fallback)");
      } catch (e) {
        console.error("Gmail Reply Generator: Failed to insert buttons anywhere:", e);
        return;
      }
    }

    // Hook actions
    toggleBtn.addEventListener("click", onToggleClicked);
    genBtn.addEventListener("click", onGenerateClicked);

    // Initialize label according to stored state for this thread
    updateButtonState();
    
    console.log("Gmail Reply Generator: Buttons created successfully");
  }

  // Update button state based on current thread ID
  function updateButtonState() {
    const toggleBtn = document.getElementById("grg-toggle-btn");
    if (!toggleBtn) return;
    
    const threadId = getThreadIdFromUrl();
    currentThreadId = threadId;
    
    safeStorageGet(`threadEnabled:${threadId}`, (res) => {
      const enabled = res[`threadEnabled:${threadId}`];
      toggleBtn.innerText = enabled ? "Disable Extension" : "Enable Extension";
    });
  }

  // Toggle button handler
  function onToggleClicked(e) {
    const btn = e.currentTarget;
    const threadId = getThreadIdFromUrl();
    currentThreadId = threadId; // Keep in sync
    const key = `threadEnabled:${threadId}`;
    
    safeStorageGet(key, async (res) => {
      const current = !!res[key];
      const next = !current;
      const update = {};
      update[key] = next;
      
      await safeStorageSet(update, () => {
        btn.innerText = next ? "Disable Extension" : "Enable Extension";
      });
      
      // Log the action
      addLog('extension', next ? 'enabled' : 'disabled', {
        threadId: threadId
      }).catch(err => console.error("Failed to log:", err));
    });
  }

  // Generate button handler
  // STEP 1: Capture email content ONLY when "Generate Reply" is pressed
  // This ensures we always read the "active" email currently on screen
  // No stale or old email text is ever used
  async function onGenerateClicked() {
    if (!isExtensionContextValid()) {
      alert("Extension context invalidated. Please reload the page or restart the extension.");
      return;
    }
    
    const threadId = getThreadIdFromUrl();
    const key = `threadEnabled:${threadId}`;
    const result = await safeStorageGet(key);
    const toggled = !!result[key];

    if (!toggled) {
      alert("Extension is disabled for this email. Click Enable Extension first.");
      return;
    }

    // Extract the exact message being replied to at THIS moment
    // This is the critical safety step - we read the email NOW, not earlier
    const original = extractOriginalEmailText();
    if (!original) {
      alert("Could not extract the email content. Make sure an email is open.");
      return;
    }

    // Truncate very long emails to prevent token limit issues
    const maxEmailLength = 3000; // characters
    const truncatedOriginal = original.length > maxEmailLength 
      ? original.substring(0, maxEmailLength) + "\n\n[Email truncated...]"
      : original;
    
    // Get tone mode from storage (default: "match")
    const toneResult = await safeStorageGet("toneMode");
    const toneMode = toneResult.toneMode || "match";
    
    // Base system instruction
    let systemInstruction = `You are an email reply assistant.

Your job:
- Understand the sender's tone, mood, and communication style.
- Generate a reply that MATCHES the tone and sentiment of the sender.
- Keep it natural, short, and conversational unless the email itself is long or formal.
- Answer ONLY what is asked in the email. Avoid adding extra topics.
- Do not create templates, multi-option responses, or overly professional language.
- Do NOT include "Subject:", or headings — just the email body.
- Do not add disclaimers or explanations.
- The reply should sound like a real person wrote it.`;

    // Adjust system instruction based on tone mode
    switch (toneMode) {
      case "friendly":
        systemInstruction += `\n\nAdditional instruction: Make the reply warmer and more friendly. Use a casual, approachable tone even if the original email is formal.`;
        break;
      case "concise":
        systemInstruction += `\n\nAdditional instruction: Keep the reply very brief and to the point. Get straight to the answer without extra pleasantries.`;
        break;
      case "professional":
        systemInstruction += `\n\nAdditional instruction: Use a more formal, professional tone. Be polite and business-appropriate even if the original email is casual.`;
        break;
      // "match" is the default, no additional instruction needed
    }

    // User prompt with the actual email content
    const userPrompt = `Here is the email I received:

${truncatedOriginal}

Please generate a natural reply that matches the tone and sentiment of this email.`;
    
    // Send both system instruction and user prompt
    const prompt = {
      systemInstruction: systemInstruction,
      userPrompt: userPrompt
    };

    // Show a small in-UI loader
    const genBtn = document.getElementById("grg-generate-btn");
    const oldText = genBtn.innerText;
    genBtn.innerText = "Generating...";
    genBtn.disabled = true;

    // Send payload to background to call Gemini
    safeSendMessage({ type: "GENERATE_REPLY", payload: { prompt } }, (response) => {
      genBtn.innerText = oldText;
      genBtn.disabled = false;

      if (!response || !response.ok) {
        const err = response && response.error ? response.error : "Unknown error";
        alert("Failed to generate reply: " + err);
        console.error("Generate failed:", response);
        return;
      }

      // Log that reply was generated
      const threadIdForLog = getThreadIdFromUrl();
      addLog('reply', 'generated', {
        threadId: threadIdForLog,
        replyLength: response.text.length
      }).catch(err => console.error("Failed to log:", err));

      // STEP 2: Show preview modal instead of directly inserting
      showPreviewModal(response.text);
    });
  }

  // STEP 2: Create preview modal to show generated reply before inserting
  function showPreviewModal(replyText) {
    // Remove existing modal if any
    const existingModal = document.getElementById("grg-preview-modal");
    if (existingModal) {
      existingModal.remove();
    }

    // Create modal overlay
    const modal = document.createElement("div");
    modal.id = "grg-preview-modal";
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Arial, sans-serif;
    `;

    // Create modal content box
    const modalContent = document.createElement("div");
    modalContent.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 20px;
      max-width: 600px;
      max-height: 80vh;
      width: 90%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
    `;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #1a73e8;
    `;
    
    const title = document.createElement("h3");
    title.textContent = "🔥 AI-Generated Reply (Preview)";
    title.style.cssText = `
      margin: 0;
      font-size: 18px;
      color: #1a73e8;
      font-weight: bold;
    `;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 30px;
      height: 30px;
      line-height: 30px;
    `;
    closeBtn.onclick = () => {
      // Log that reply was rejected (closed without inserting)
      const threadId = getThreadIdFromUrl();
      addLog('reply', 'rejected', {
        threadId: threadId,
        replyLength: replyText.length
      }).catch(err => console.error("Failed to log:", err));
      modal.remove();
    };

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Safety reminder
    const reminder = document.createElement("div");
    reminder.style.cssText = `
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 12px;
      font-size: 12px;
      color: #856404;
      line-height: 1.4;
    `;
    reminder.textContent = "⚠️ Please review the generated reply and compare it with the original email above to ensure it matches correctly before inserting.";

    // Preview text area
    const previewArea = document.createElement("div");
    previewArea.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      background: #f8f9fa;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 16px;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      max-height: 400px;
    `;
    previewArea.textContent = replyText;

    // Buttons container
    const buttonsContainer = document.createElement("div");
    buttonsContainer.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    `;

    // Cancel button
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      padding: 10px 20px;
      border-radius: 6px;
      border: 1px solid #888;
      background: #fff;
      cursor: pointer;
      font-size: 14px;
      color: #333;
    `;
    cancelBtn.onclick = () => {
      // Log that reply was rejected
      const threadId = getThreadIdFromUrl();
      addLog('reply', 'rejected', {
        threadId: threadId,
        replyLength: replyText.length
      }).catch(err => console.error("Failed to log:", err));
      modal.remove();
    };

    // Insert button
    const insertBtn = document.createElement("button");
    insertBtn.textContent = "✓ Insert into Reply Box";
    insertBtn.style.cssText = `
      padding: 10px 20px;
      border-radius: 6px;
      border: 1px solid #1a73e8;
      background: #1a73e8;
      color: #fff;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
    `;
    insertBtn.onclick = () => {
      // STEP 3: Insert only after user confirmation
      // Log that reply was accepted
      const threadId = getThreadIdFromUrl();
      addLog('reply', 'accepted', {
        threadId: threadId,
        replyLength: replyText.length
      }).catch(err => console.error("Failed to log:", err));
      modal.remove();
      insertReplyIntoEditor(replyText);
    };

    buttonsContainer.appendChild(cancelBtn);
    buttonsContainer.appendChild(insertBtn);

    // Assemble modal
    modalContent.appendChild(header);
    modalContent.appendChild(reminder);
    modalContent.appendChild(previewArea);
    modalContent.appendChild(buttonsContainer);
    modal.appendChild(modalContent);

    // Add to document
    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        // Log that reply was rejected (clicked outside)
        const threadId = getThreadIdFromUrl();
        addLog('reply', 'rejected', {
          threadId: threadId,
          replyLength: replyText.length
        }).catch(err => console.error("Failed to log:", err));
        modal.remove();
      }
    });

    // Close on Escape key
    const escapeHandler = (e) => {
      if (e.key === "Escape") {
        // Log that reply was rejected (ESC pressed)
        const threadId = getThreadIdFromUrl();
        addLog('reply', 'rejected', {
          threadId: threadId,
          replyLength: replyText.length
        }).catch(err => console.error("Failed to log:", err));
        modal.remove();
        document.removeEventListener("keydown", escapeHandler);
      }
    };
    document.addEventListener("keydown", escapeHandler);
  }

  // Extract original email text — STEP 1: Capture ONLY when Generate Reply is pressed
  // This ensures we always read the "active" email currently on screen
  function extractOriginalEmailText() {
    // In Gmail conversation view, we want the LAST message (the one being replied to)
    // Try to find all messages and get the most recent one
    const messageSelectors = [
      "div[role='listitem']",  // Individual messages in conversation
      ".nH.if",                // Message container
      ".a3s.aiL"               // Direct message body
    ];

    let messages = [];
    for (const s of messageSelectors) {
      const found = document.querySelectorAll(s);
      if (found.length > 0) {
        messages = Array.from(found);
        break;
      }
    }

    // If we found multiple messages, get the LAST one (most recent in thread)
    // This is the email the user is replying to
    let targetMessage = null;
    if (messages.length > 0) {
      // Get the last visible message (the one being replied to)
      targetMessage = messages[messages.length - 1];
    }

    // Try to extract text from the target message
    if (targetMessage) {
      // Look for the actual message body within this message container
      const bodySelectors = [
        ".a3s.aiL",           // Common email body container
        ".ii.gt",              // Older container
        "div[dir='ltr']",      // Text direction container
        "div[role='textbox']"  // Sometimes used for message content
      ];

      for (const s of bodySelectors) {
        const bodyEl = targetMessage.querySelector(s);
        if (bodyEl) {
          const text = bodyEl.innerText || bodyEl.textContent;
          if (text && text.trim().length > 0) {
            return text.trim();
          }
        }
      }

      // Fallback: use the entire message container
      const text = targetMessage.innerText || targetMessage.textContent;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }

    // Fallback: try direct selectors (for single message view)
    const directSelectors = [
      ".a3s.aiL",
      ".ii.gt",
      "div[dir='ltr']"
    ];

    for (const s of directSelectors) {
      const el = document.querySelector(s);
      if (el) {
        const text = el.innerText || el.textContent;
        if (text && text.trim().length > 0) {
          return text.trim();
        }
      }
    }

    return null;
  }

  // STEP 3: Insert reply text into Gmail's reply editor
  // This is ONLY called after user confirms in the preview modal
  // The user still needs to manually click Gmail's Send button
  function insertReplyIntoEditor(text) {
    // Try multiple editor selectors
    const selectors = [
      "div[aria-label='Message Body']",
      "div[role='textbox'][contenteditable='true']",
      ".editable.LW-avf.tS-tW",
      "div[contenteditable='true']"
    ];

    const editor = queryAny(selectors, document);
    if (!editor) {
      alert("Reply editor not found. Click Reply to open the editor, then try again.");
      return;
    }

    // Insert plain text safely
    editor.focus();
    try {
      // Use plain text insertion to avoid untrusted HTML.
      // Create text nodes and clear existing content
      editor.innerHTML = "";
      const textNode = document.createTextNode(text);
      editor.appendChild(textNode);

      // Move caret to end
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {
      console.error("Insert failed:", err);
      alert("Failed to insert reply into editor. See console.");
    }
  }

  // Observe changes in DOM to inject our buttons when an email opens
  const observer = new MutationObserver((mutations) => {
    // We attempt to create buttons whenever mutations happen.
    // The createButtons function ignores duplicates.
    createButtons();
  });

  // Start observing once DOM is ready
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    // Wait for body to be available
    const bodyObserver = new MutationObserver(() => {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        bodyObserver.disconnect();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }

  // Also listen for URL changes (Gmail uses pushState for navigation)
  let lastUrl = location.href;
  const urlCheckInterval = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("Gmail Reply Generator: URL changed, checking for buttons");
      // URL changed - update button state for new thread
      const container = document.getElementById(BUTTON_CONTAINER_ID);
      if (container) {
        updateButtonState();
      } else {
        // Small delay to let Gmail render the email view
        setTimeout(() => {
          createButtons();
        }, 300);
      }
    }
  }, 500);

  // Retry mechanism: try to create buttons multiple times with delays
  // Show logs modal
  async function showLogsModal() {
    // Check if modal already exists
    let modal = document.getElementById("grg-logs-modal");
    if (modal) {
      modal.style.display = "flex";
      loadLogsIntoModal();
      return;
    }

    // Create modal overlay
    modal = document.createElement("div");
    modal.id = "grg-logs-modal";
    modal.style.cssText = `
      display: flex;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10000;
      align-items: center;
      justify-content: center;
      font-family: Arial, sans-serif;
    `;

    // Create modal content
    const modalContent = document.createElement("div");
    modalContent.style.cssText = `
      background: white;
      border-radius: 8px;
      width: 90%;
      max-width: 700px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    `;

    // Modal header
    const modalHeader = document.createElement("div");
    modalHeader.style.cssText = `
      padding: 16px 20px;
      border-bottom: 1px solid #ddd;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    const modalTitle = document.createElement("h3");
    modalTitle.textContent = "Activity Logs";
    modalTitle.style.cssText = "margin: 0; font-size: 18px; color: #333;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 28px;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 30px;
      height: 30px;
      line-height: 1;
    `;
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.color = "#333";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.color = "#666";
    });
    modalHeader.appendChild(modalTitle);
    modalHeader.appendChild(closeBtn);

    // Modal body with tabs
    const modalBody = document.createElement("div");
    modalBody.style.cssText = `
      padding: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      flex: 1;
    `;

    // Tab buttons
    const tabContainer = document.createElement("div");
    tabContainer.style.cssText = `
      display: flex;
      border-bottom: 2px solid #ddd;
      background: #f5f5f5;
    `;
    const extensionTab = document.createElement("button");
    extensionTab.textContent = "Extension Logs";
    extensionTab.className = "grg-log-tab active";
    extensionTab.style.cssText = `
      flex: 1;
      padding: 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      border-bottom: 2px solid transparent;
      color: #666;
    `;
    const replyTab = document.createElement("button");
    replyTab.textContent = "Reply Logs";
    replyTab.className = "grg-log-tab";
    replyTab.style.cssText = `
      flex: 1;
      padding: 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      border-bottom: 2px solid transparent;
      color: #666;
    `;

    // Tab content containers
    const extensionLogsContainer = document.createElement("div");
    extensionLogsContainer.id = "grg-extension-logs";
    extensionLogsContainer.className = "grg-log-section active";
    extensionLogsContainer.style.cssText = `
      padding: 16px;
      overflow-y: auto;
      max-height: calc(80vh - 120px);
      display: block;
    `;

    const replyLogsContainer = document.createElement("div");
    replyLogsContainer.id = "grg-reply-logs";
    replyLogsContainer.className = "grg-log-section";
    replyLogsContainer.style.cssText = `
      padding: 16px;
      overflow-y: auto;
      max-height: calc(80vh - 120px);
      display: none;
    `;

    // Tab switching
    extensionTab.addEventListener("click", () => {
      extensionTab.classList.add("active");
      replyTab.classList.remove("active");
      extensionLogsContainer.style.display = "block";
      replyLogsContainer.style.display = "none";
      extensionTab.style.borderBottomColor = "#1a73e8";
      extensionTab.style.color = "#1a73e8";
      extensionTab.style.fontWeight = "bold";
      replyTab.style.borderBottomColor = "transparent";
      replyTab.style.color = "#666";
      replyTab.style.fontWeight = "normal";
    });

    replyTab.addEventListener("click", () => {
      replyTab.classList.add("active");
      extensionTab.classList.remove("active");
      replyLogsContainer.style.display = "block";
      extensionLogsContainer.style.display = "none";
      replyTab.style.borderBottomColor = "#1a73e8";
      replyTab.style.color = "#1a73e8";
      replyTab.style.fontWeight = "bold";
      extensionTab.style.borderBottomColor = "transparent";
      extensionTab.style.color = "#666";
      extensionTab.style.fontWeight = "normal";
    });

    // Set initial active tab styles
    extensionTab.style.borderBottomColor = "#1a73e8";
    extensionTab.style.color = "#1a73e8";
    extensionTab.style.fontWeight = "bold";

    tabContainer.appendChild(extensionTab);
    tabContainer.appendChild(replyTab);

    modalBody.appendChild(tabContainer);
    modalBody.appendChild(extensionLogsContainer);
    modalBody.appendChild(replyLogsContainer);

    modalContent.appendChild(modalHeader);
    modalContent.appendChild(modalBody);

    modal.appendChild(modalContent);

    // Close on overlay click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });

    // Close on ESC key
    const handleEsc = (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") {
        modal.style.display = "none";
        document.removeEventListener("keydown", handleEsc);
      }
    };
    document.addEventListener("keydown", handleEsc);

    document.body.appendChild(modal);
    loadLogsIntoModal();
  }

  // Load logs into modal with categorization
  async function loadLogsIntoModal() {
    const extensionContainer = document.getElementById("grg-extension-logs");
    const replyContainer = document.getElementById("grg-reply-logs");
    
    if (!extensionContainer || !replyContainer) return;

    try {
      const result = await safeStorageGet([LOGS_STORAGE_KEY]);
      const logs = result[LOGS_STORAGE_KEY] || [];

      // Separate logs by type
      const extensionLogs = logs.filter(log => log.type === 'extension');
      const replyLogs = logs.filter(log => log.type === 'reply');

      // Render extension logs
      if (extensionLogs.length === 0) {
        extensionContainer.innerHTML = '<p style="text-align: center; color: #666; margin: 20px 0;">No extension activity logs yet.</p>';
      } else {
        extensionContainer.innerHTML = extensionLogs.map(log => {
          const actionLabel = {
            'enabled': 'Extension Enabled',
            'disabled': 'Extension Disabled'
          }[log.action] || log.action;
          
          const icon = {
            'enabled': '✓',
            'disabled': '✗'
          }[log.action] || '•';
          
          const typeClass = `extension-${log.action}`;
          
          return `
            <div class="grg-log-entry ${typeClass}" style="
              padding: 10px;
              margin-bottom: 8px;
              border-left: 3px solid ${log.action === 'enabled' ? '#4caf50' : '#f44336'};
              background: #f9f9f9;
              border-radius: 3px;
              font-size: 12px;
            ">
              <div style="color: #666; font-size: 11px; margin-bottom: 4px;">${log.date} at ${log.time}</div>
              <div style="font-weight: bold; color: #333;">${icon} ${actionLabel}</div>
              ${log.details && log.details.threadId ? `<div style="color: #666; font-size: 11px; margin-top: 4px;">Thread: ${log.details.threadId.substring(0, 20)}...</div>` : ''}
            </div>
          `;
        }).join('');
      }

      // Render reply logs
      if (replyLogs.length === 0) {
        replyContainer.innerHTML = '<p style="text-align: center; color: #666; margin: 20px 0;">No reply generation logs yet.</p>';
      } else {
        replyContainer.innerHTML = replyLogs.map(log => {
          const actionLabel = {
            'generated': 'Reply Generated',
            'accepted': 'Reply Accepted',
            'rejected': 'Reply Rejected'
          }[log.action] || log.action;
          
          const icon = {
            'generated': '⚡',
            'accepted': '✓',
            'rejected': '✗'
          }[log.action] || '•';
          
          const borderColor = {
            'generated': '#2196f3',
            'accepted': '#4caf50',
            'rejected': '#ff9800'
          }[log.action] || '#ddd';
          
          let detailsText = '';
          if (log.details) {
            const parts = [];
            if (log.details.replyLength) parts.push(`Length: ${log.details.replyLength} chars`);
            if (log.details.threadId) parts.push(`Thread: ${log.details.threadId.substring(0, 15)}...`);
            if (parts.length > 0) detailsText = parts.join(' • ');
          }
          
          return `
            <div class="grg-log-entry reply-${log.action}" style="
              padding: 10px;
              margin-bottom: 8px;
              border-left: 3px solid ${borderColor};
              background: #f9f9f9;
              border-radius: 3px;
              font-size: 12px;
            ">
              <div style="color: #666; font-size: 11px; margin-bottom: 4px;">${log.date} at ${log.time}</div>
              <div style="font-weight: bold; color: #333;">${icon} ${actionLabel}</div>
              ${detailsText ? `<div style="color: #666; font-size: 11px; margin-top: 4px;">${detailsText}</div>` : ''}
            </div>
          `;
        }).join('');
      }
    } catch (error) {
      console.error("Failed to load logs:", error);
      extensionContainer.innerHTML = '<p style="text-align: center; color: #f44336; margin: 20px 0;">Error loading logs. Please try again.</p>';
      replyContainer.innerHTML = '<p style="text-align: center; color: #f44336; margin: 20px 0;">Error loading logs. Please try again.</p>';
    }
  }

  // This handles cases where Gmail loads content asynchronously
  let retryCount = 0;
  const maxRetries = 10;
  const retryInterval = setInterval(() => {
    if (retryCount >= maxRetries) {
      clearInterval(retryInterval);
      return;
    }
    
    const container = document.getElementById(BUTTON_CONTAINER_ID);
    const isEmail = isEmailView();
    
    if (isEmail && !container) {
      console.log(`Gmail Reply Generator: Retry ${retryCount + 1}/${maxRetries} - attempting to create buttons`);
      createButtons();
    } else if (!isEmail && container) {
      // Remove buttons if we're no longer in email view
      container.remove();
    }
    
    retryCount++;
  }, 1000);

  // Ensure buttons are added at least once on load (with delay for async content)
  setTimeout(() => {
    createButtons();
  }, 500);
  
  // Also try immediately
  createButtons();
})();
