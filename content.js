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
  
  // Track logging enabled state
  let loggingEnabled = true; // Default to enabled
  
  // Global flag to track if context has been invalidated (to prevent repeated checks)
  let contextInvalidated = false;

  // Helper function to check if extension context is valid
  function isExtensionContextValid() {
    // If we've already detected invalidation, don't check again
    if (contextInvalidated) {
      return false;
    }
    
    try {
      // Try to access chrome.runtime.id - if it throws, context is invalid
      if (!chrome || !chrome.runtime) {
        contextInvalidated = true;
        return false;
      }
      // Accessing chrome.runtime.id will throw if context is invalidated
      const id = chrome.runtime.id;
      // Also check if storage is available
      if (!chrome.storage || !chrome.storage.local) {
        contextInvalidated = true;
        return false;
      }
      const isValid = id !== undefined;
      if (!isValid) {
        contextInvalidated = true;
      }
      return isValid;
    } catch (e) {
      // Context is invalid if accessing runtime.id throws
      contextInvalidated = true;
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

  // Safe wrapper for chrome.storage.local.get or chrome.storage.sync.get
  function safeStorageGet(keys, callback, useSync = false) {
    // Double-check context validity before proceeding
    if (!isExtensionContextValid()) {
      if (callback) callback({});
      return Promise.resolve({});
    }
    
    return new Promise((resolve) => {
      // Check again right before making the API call (context might have been invalidated)
      if (!isExtensionContextValid()) {
        resolve({});
        if (callback) callback({});
        return;
      }
      
      try {
        // Final check - if context is invalid, this will fail gracefully
        const storage = useSync ? chrome.storage.sync : chrome.storage.local;
        if (!chrome || !chrome.storage || !storage) {
          resolve({});
          if (callback) callback({});
          return;
        }
        
        storage.get(keys, (result) => {
          // Check context after async operation
          if (!isExtensionContextValid()) {
            resolve({});
            if (callback) callback({});
            return;
          }
          
          // Check for errors without accessing lastError if context is invalidated
          // This prevents Chrome from logging the error
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message;
              // Check if it's a context invalidated error
              if (isContextInvalidatedError({ message: errorMsg })) {
                // Mark context as invalidated and silently handle
                contextInvalidated = true;
                resolve({});
                if (callback) callback({});
                return;
              } else {
                console.error("Storage get error:", errorMsg);
              }
            }
          } catch (e) {
            // If accessing lastError throws, context is invalidated
            contextInvalidated = true;
            resolve({});
            if (callback) callback({});
            return;
          }
          
          resolve(result);
          if (callback) callback(result);
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          // Silently handle context invalidation - it's expected during extension reloads
        } else {
          console.error("Storage get exception:", error);
        }
        resolve({});
        if (callback) callback({});
      }
    });
  }

  // Safe wrapper for chrome.storage.local.set or chrome.storage.sync.set
  function safeStorageSet(data, callback, useSync = false) {
    // Double-check context validity before proceeding
    if (!isExtensionContextValid()) {
      if (callback) callback();
      return Promise.resolve();
    }
    
    return new Promise((resolve) => {
      // Check again right before making the API call (context might have been invalidated)
      if (!isExtensionContextValid()) {
        resolve();
        if (callback) callback();
        return;
      }
      
      try {
        // Final check - if context is invalid, this will fail gracefully
        const storage = useSync ? chrome.storage.sync : chrome.storage.local;
        if (!chrome || !chrome.storage || !storage) {
          resolve();
          if (callback) callback();
          return;
        }
        
        storage.set(data, () => {
          // Check context after async operation
          if (!isExtensionContextValid()) {
            resolve();
            if (callback) callback();
            return;
          }
          
          // Check for errors without accessing lastError if context is invalidated
          // This prevents Chrome from logging the error
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message;
              // Check if it's a context invalidated error
              if (isContextInvalidatedError({ message: errorMsg })) {
                // Mark context as invalidated and silently handle
                contextInvalidated = true;
              } else {
                console.error("Storage set error:", errorMsg);
              }
            }
          } catch (e) {
            // If accessing lastError throws, context is invalidated
            contextInvalidated = true;
          }
          
          resolve();
          if (callback) callback();
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          // Silently handle context invalidation - it's expected during extension reloads
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
      // Show user-friendly error only when user actively tries to use the extension
      if (callback) {
        callback({ ok: false, error: "Extension context invalidated. Please reload the page to continue using the extension." });
      }
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

  // Check if logging is enabled
  async function isLoggingEnabled() {
    if (!isExtensionContextValid()) {
      return false;
    }
    
    try {
      const result = await safeStorageGet("loggingEnabled", null, true); // Use sync storage
      return result.loggingEnabled !== false; // Default to true if not set
    } catch (e) {
      return true; // Default to enabled on error
    }
  }

  // Log when logging is enabled/disabled (bypasses the enabled check)
  async function logLoggingToggle(enabled) {
    // Check context validity
    if (!isExtensionContextValid()) {
      return;
    }
    
    try {
      const logEntry = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        type: 'extension',
        action: enabled ? 'logging_enabled' : 'logging_disabled',
        details: {}
      };

      // Get existing logs from sync storage
      const result = await safeStorageGet([LOGS_STORAGE_KEY], null, true);
      const logs = result[LOGS_STORAGE_KEY] || [];

      // Add new log at the beginning
      logs.unshift(logEntry);

      // Keep only the most recent MAX_LOGS entries
      if (logs.length > MAX_LOGS) {
        logs.splice(MAX_LOGS);
      }

      // Save back to sync storage
      await safeStorageSet({ [LOGS_STORAGE_KEY]: logs }, null, true);
      
      console.log("Logging toggle logged:", logEntry);
    } catch (error) {
      if (!isContextInvalidatedError(error)) {
        console.error("Failed to log logging toggle:", error);
      }
    }
  }

  // Logging utility functions
  async function addLog(type, action, details = {}) {
    // Check if logging is enabled first
    const enabled = await isLoggingEnabled();
    if (!enabled) {
      return; // Don't log if logging is disabled
    }
    
    // Check context validity before starting
    if (!isExtensionContextValid()) {
      // Silently skip logging when context is invalidated
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
        // Silently skip logging when context is invalidated
        return;
      }

      // Get existing logs from sync storage for persistence
      const result = await safeStorageGet([LOGS_STORAGE_KEY], null, true);
      
      // Check context again after async operation
      if (!isExtensionContextValid()) {
        // Silently skip logging when context is invalidated
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
        // Silently skip logging when context is invalidated
        return;
      }

      // Save back to sync storage for persistence across reloads
      await safeStorageSet({ [LOGS_STORAGE_KEY]: logs }, null, true);
      
      console.log("Log added:", logEntry);
    } catch (error) {
      // Silently handle context invalidated errors - they're expected when extension reloads
      if (!isContextInvalidatedError(error)) {
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

  // Check if we're viewing an email or compose view (not just inbox list)
  function isEmailView() {
    // Check URL first - if it has a thread ID, we're viewing an email
    const hasThreadId = location.href.match(/#.*\/([A-Za-z0-9_-]{10,})/);
    if (hasThreadId) {
      return true;
    }
    
    // Check if we're in compose view
    const composeSelectors = [
      "div[role='dialog'][aria-label*='Compose']",  // Compose dialog
      "div[aria-label*='Compose']",                 // Compose label
      "div[aria-label='New Message']",              // New message
      "div[data-tooltip='Send']",                   // Send button in compose
      "div[aria-label='Send']",                     // Send button
      "div[role='textbox'][aria-label*='Message Body']", // Compose message body
      "div[contenteditable='true'][aria-label*='Message']", // Compose editor
      "div[data-tooltip='Formatting options']"      // Formatting toolbar
    ];
    
    const isCompose = queryAny(composeSelectors) !== null;
    if (isCompose) {
      return true; // Show buttons in compose view too
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
      "div[data-legacy-thread-id]",            // Legacy thread ID
      "div[role='main'] div[data-thread-id]",  // Thread in main area
      "div[aria-label*='Email']",              // Email label
      "div[data-message-id][role='article']"   // Message article
    ];
    
    const found = queryAny(emailContentSelectors) !== null;
    
    // Also check for reply/forward buttons which indicate email view
    if (!found) {
      const hasReplyButtons = queryAny([
        "div[aria-label='Reply']",
        "div[aria-label='Forward']",
        "div[data-tooltip='Reply']",
        "div[data-tooltip='Forward']"
      ]) !== null;
      if (hasReplyButtons) {
        return true;
      }
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
    // Check context validity first - if invalidated, don't try to create buttons
    if (!isExtensionContextValid()) {
      // Silently skip if context is invalidated - this is expected during extension reloads
      return;
    }
    
    // Check if we're in a view where buttons should be shown (email or compose)
    const shouldShowButtons = isEmailView();
    
    if (!shouldShowButtons) {
      // Only remove buttons if we're definitely in inbox list (not just transitioning)
      // Check if we're actually in inbox list (not just a temporary state)
      const isInboxList = !queryAny([
        "div[role='main'] div[role='article']",
        "div[data-thread-perm-id]",
        "div[role='dialog']",
        "div[aria-label*='Compose']"
      ]);
      
      if (isInboxList) {
        // Remove buttons if they exist in inbox view
        const existingContainer = document.getElementById(BUTTON_CONTAINER_ID);
        if (existingContainer) {
          existingContainer.remove();
        }
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

    // Check Connection button
    const checkConnBtn = document.createElement("button");
    checkConnBtn.id = "grg-check-conn-btn";
    checkConnBtn.innerText = "Check Connection";
    checkConnBtn.style.cssText = `
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #34a853;
      background: #34a853;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    `;
    checkConnBtn.addEventListener("mouseenter", () => {
      checkConnBtn.style.background = "#2d8f47";
    });
    checkConnBtn.addEventListener("mouseleave", () => {
      checkConnBtn.style.background = "#34a853";
    });
    checkConnBtn.addEventListener("click", onCheckConnectionClicked);

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

    container.appendChild(checkConnBtn);
    container.appendChild(toggleBtn);
    container.appendChild(genBtn);
    container.appendChild(logsBtn);

    // Try multiple insertion strategies
    let inserted = false;

    // Strategy 0: Check if we're in compose view and insert there
    const composeDialog = queryAny([
      "div[role='dialog'][aria-label*='Compose']",
      "div[aria-label*='Compose']",
      "div[aria-label='New Message']"
    ]);
    
    if (composeDialog) {
      // Try to find the compose toolbar/header
      const composeToolbar = queryAny([
        "div[data-tooltip='Send']",
        "div[aria-label='Send']",
        "div[role='toolbar']"
      ], composeDialog);
      
      if (composeToolbar && composeToolbar.parentElement) {
        try {
          composeToolbar.parentElement.insertBefore(container, composeToolbar.nextSibling);
          inserted = true;
          console.log("Gmail Reply Generator: Buttons inserted in compose view");
        } catch (e) {
          // Try alternative insertion
          try {
            composeDialog.insertBefore(container, composeDialog.firstChild);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted at top of compose dialog");
          } catch (e2) {
            console.warn("Gmail Reply Generator: Failed to insert in compose view:", e2);
          }
        }
      } else {
        // Try inserting at top of compose dialog
        try {
          composeDialog.insertBefore(container, composeDialog.firstChild);
          inserted = true;
          console.log("Gmail Reply Generator: Buttons inserted at top of compose dialog");
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert in compose dialog:", e);
        }
      }
    }

    // Strategy 1: Attach to toolbar if found
    if (!inserted && toolbar) {
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

    // Strategy 3: Try to insert near reply/forward buttons directly
    if (!inserted) {
      const replyButton = queryAny([
        "div[aria-label='Reply']",
        "div[aria-label='Forward']",
        "div[data-tooltip='Reply']",
        "div[data-tooltip='Forward']"
      ]);
      
      if (replyButton) {
        try {
          // Try inserting as sibling after reply button
          if (replyButton.parentElement) {
            replyButton.parentElement.insertBefore(container, replyButton.nextSibling);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted after reply button");
          }
          
          if (!inserted) {
            // Try inserting before reply button
            replyButton.parentElement.insertBefore(container, replyButton);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted before reply button");
          }
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert near reply button:", e);
        }
      }
    }

    // Strategy 4: Find the first message in conversation and insert near it
    if (!inserted) {
      const messageSelectors = [
        "div[role='listitem']",
        "div[data-message-id]",
        "div[role='article']",
        "div[data-thread-perm-id]"
      ];
      
      for (const selector of messageSelectors) {
        const message = document.querySelector(selector);
        if (message) {
          try {
            // Try inserting before message
            if (message.parentElement) {
              message.parentElement.insertBefore(container, message);
              inserted = true;
              console.log("Gmail Reply Generator: Buttons inserted before message");
              break;
            }
            
            // Try inserting as first child
            if (!inserted && message.firstChild) {
              message.insertBefore(container, message.firstChild);
              inserted = true;
              console.log("Gmail Reply Generator: Buttons inserted as first child of message");
              break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      }
    }

    // Strategy 5: Find main content area and insert at top
    if (!inserted) {
      const mainContent = document.querySelector("div[role='main']");
      if (mainContent) {
        try {
          // Try to find the first visible element in main content
          const firstChild = mainContent.firstElementChild;
          if (firstChild) {
            mainContent.insertBefore(container, firstChild);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted at top of main content");
          } else {
            mainContent.appendChild(container);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons appended to main content");
          }
        } catch (e) {
          console.warn("Gmail Reply Generator: Failed to insert in main content:", e);
        }
      }
    }

    // Strategy 6: Try to find any toolbar or action area
    if (!inserted) {
      const actionAreas = document.querySelectorAll("div[role='toolbar'], div[aria-label*='actions'], div[data-tooltip]");
      for (const area of actionAreas) {
        if (area.parentElement) {
          try {
            area.parentElement.insertBefore(container, area.nextSibling);
            inserted = true;
            console.log("Gmail Reply Generator: Buttons inserted near action area");
            break;
          } catch (e) {
            // Continue
          }
        }
      }
    }

    // Final fallback: Insert at a fixed position in body
    if (!inserted) {
      try {
        // Try to find a good spot in body
        const bodyFirstChild = document.body.firstElementChild;
        if (bodyFirstChild) {
          document.body.insertBefore(container, bodyFirstChild);
        } else {
          document.body.appendChild(container);
        }
        inserted = true;
        console.log("Gmail Reply Generator: Buttons inserted in body (fallback)");
      } catch (e) {
        console.error("Gmail Reply Generator: Failed to insert buttons anywhere:", e);
        // Don't return - we'll retry later
      }
    }
    
    // Verify insertion
    if (inserted && !document.getElementById(BUTTON_CONTAINER_ID)) {
      console.warn("Gmail Reply Generator: Buttons were inserted but not found in DOM - may have been removed");
    } else if (inserted) {
      console.log("Gmail Reply Generator: Buttons successfully created and inserted");
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
    // Check context validity before attempting to access storage
    if (!isExtensionContextValid()) {
      // Silently skip if context is invalidated - this is expected during extension reloads
      return;
    }
    
    const toggleBtn = document.getElementById("grg-toggle-btn");
    if (!toggleBtn) return;
    
    const threadId = getThreadIdFromUrl();
    currentThreadId = threadId;
    
    safeStorageGet(`threadEnabled:${threadId}`, (res) => {
      // Check context again after async operation
      if (!isExtensionContextValid()) {
        return;
      }
      
      const enabled = res[`threadEnabled:${threadId}`];
      if (toggleBtn) {
        toggleBtn.innerText = enabled ? "Disable Extension" : "Enable Extension";
      }
    });
  }

  // Check Connection button handler
  async function onCheckConnectionClicked() {
    if (!isExtensionContextValid()) {
      alert("Extension context invalidated. Please reload the page or restart the extension.");
      return;
    }

    const checkConnBtn = document.getElementById("grg-check-conn-btn");
    if (!checkConnBtn) return;

    const oldText = checkConnBtn.innerText;
    checkConnBtn.innerText = "Checking...";
    checkConnBtn.disabled = true;

    // Send connection check request to background
    safeSendMessage({ type: "CHECK_CONNECTION" }, async (response) => {
      checkConnBtn.innerText = oldText;
      checkConnBtn.disabled = false;

      if (!response || !response.ok) {
        const err = response && response.error ? response.error : "Unknown error";
        alert("Connection check failed: " + err);
        console.error("Connection check failed:", response);
        return;
      }

      // Connection successful - show confirmation modal
      showConnectionSuccessModal();
    });
  }

  // Show connection success confirmation modal
  function showConnectionSuccessModal() {
    // Remove existing modal if any
    const existingModal = document.getElementById("grg-connection-success-modal");
    if (existingModal) {
      existingModal.remove();
    }

    // Create modal overlay
    const modal = document.createElement("div");
    modal.id = "grg-connection-success-modal";
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
      padding: 24px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
    `;

    // Success icon and message
    const successIcon = document.createElement("div");
    successIcon.style.cssText = `
      text-align: center;
      font-size: 48px;
      margin-bottom: 16px;
    `;
    successIcon.textContent = "✓";

    const successMessage = document.createElement("div");
    successMessage.style.cssText = `
      text-align: center;
      font-size: 18px;
      font-weight: bold;
      color: #34a853;
      margin-bottom: 8px;
    `;
    successMessage.textContent = "Connection Successful!";

    const detailsMessage = document.createElement("div");
    detailsMessage.style.cssText = `
      text-align: center;
      font-size: 14px;
      color: #666;
      margin-bottom: 24px;
      line-height: 1.5;
    `;
    detailsMessage.textContent = "All connections are properly established. The extension will now be enabled. Click 'Generate Reply' when you're ready to generate a reply.";

    // Buttons container
    const buttonsContainer = document.createElement("div");
    buttonsContainer.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: center;
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
      modal.remove();
    };

    // Confirm button
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Continue";
    confirmBtn.style.cssText = `
      padding: 10px 20px;
      border-radius: 6px;
      border: 1px solid #34a853;
      background: #34a853;
      color: #fff;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
    `;
    confirmBtn.onclick = async () => {
      modal.remove();
      
      // Enable extension for current thread
      const threadId = getThreadIdFromUrl();
      const key = `threadEnabled:${threadId}`;
      await safeStorageSet({ [key]: true });
      
      // Update button state
      const toggleBtn = document.getElementById("grg-toggle-btn");
      if (toggleBtn) {
        toggleBtn.innerText = "Disable Extension";
      }
      
      // Log the action
      addLog('extension', 'enabled', {
        threadId: threadId
      }).catch(err => console.error("Failed to log:", err));
      
      // Extension is now enabled - user can click "Generate Reply" button when ready
    };

    buttonsContainer.appendChild(cancelBtn);
    buttonsContainer.appendChild(confirmBtn);

    // Assemble modal
    modalContent.appendChild(successIcon);
    modalContent.appendChild(successMessage);
    modalContent.appendChild(detailsMessage);
    modalContent.appendChild(buttonsContainer);
    modal.appendChild(modalContent);

    // Add to document
    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

    // Close on Escape key
    const escapeHandler = (e) => {
      if (e.key === "Escape") {
        modal.remove();
        document.removeEventListener("keydown", escapeHandler);
      }
    };
    document.addEventListener("keydown", escapeHandler);
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
  // Function to automatically open Gmail's reply editor
  async function openReplyEditor() {
    // First, check if editor is already open
    const existingEditor = queryAny([
      "div[aria-label='Message Body']",
      "div[role='textbox'][contenteditable='true'][aria-label*='Message']",
      ".editable.LW-avf.tS-tW",
      "div[contenteditable='true'][aria-label*='Message Body']"
    ]);
    
    if (existingEditor) {
      console.log("Gmail Reply Generator: Reply editor already open");
      return true;
    }
    
    // Try multiple strategies to find and click the Reply button
    const replySelectors = [
      "div[aria-label='Reply']",
      "div[data-tooltip='Reply']",
      "div[role='button'][aria-label*='Reply']",
      "div[jsaction*='reply']",
      "div[aria-label='Reply'][role='button']",
      "div[data-tooltip='Reply'][role='button']",
      "span[aria-label='Reply']",
      "button[aria-label='Reply']"
    ];
    
    let replyButton = queryAny(replySelectors);
    
    // If not found, try searching by text content
    if (!replyButton) {
      const allButtons = document.querySelectorAll("div[role='button'], button, div[jsaction], span[role='button']");
      for (const btn of allButtons) {
        const text = (btn.textContent || btn.innerText || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        
        // Check if it's a Reply button (not Reply All)
        if ((text === 'reply' || text.includes('reply') && !text.includes('reply all')) ||
            (ariaLabel === 'reply' || (ariaLabel.includes('reply') && !ariaLabel.includes('reply all'))) ||
            (tooltip === 'reply' || (tooltip.includes('reply') && !tooltip.includes('reply all'))) ||
            (title === 'reply' || (title.includes('reply') && !title.includes('reply all')))) {
          replyButton = btn;
          console.log("Gmail Reply Generator: Found Reply button by text/attribute");
          break;
        }
      }
    }
    
    // If still not found, try to find it in common Gmail toolbar locations
    if (!replyButton) {
      const toolbarSelectors = [
        "div[role='toolbar']",
        "div[data-tooltip]",
        "div[aria-label*='actions']"
      ];
      
      for (const toolbarSelector of toolbarSelectors) {
        const toolbars = document.querySelectorAll(toolbarSelector);
        for (const toolbar of toolbars) {
          const buttons = toolbar.querySelectorAll("div[role='button'], button, div[jsaction]");
          for (const btn of buttons) {
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
            
            if ((ariaLabel === 'reply' || ariaLabel.includes('reply')) && !ariaLabel.includes('reply all')) {
              replyButton = btn;
              console.log("Gmail Reply Generator: Found Reply button in toolbar");
              break;
            }
          }
          if (replyButton) break;
        }
        if (replyButton) break;
      }
    }
    
    if (!replyButton) {
      console.warn("Gmail Reply Generator: Reply button not found with any selector");
      return false;
    }
    
    // Try multiple click methods
    let clicked = false;
    
    // Method 1: Direct click
    try {
      replyButton.click();
      clicked = true;
      console.log("Gmail Reply Generator: Clicked Reply button (method 1)");
    } catch (e) {
      console.warn("Gmail Reply Generator: Direct click failed:", e);
    }
    
    // Method 2: Mouse events
    if (!clicked) {
      try {
        const mouseEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        replyButton.dispatchEvent(mouseEvent);
        clicked = true;
        console.log("Gmail Reply Generator: Clicked Reply button (method 2)");
      } catch (e) {
        console.warn("Gmail Reply Generator: Mouse event click failed:", e);
      }
    }
    
    // Method 3: Focus and Enter key
    if (!clicked) {
      try {
        replyButton.focus();
        const keyEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        replyButton.dispatchEvent(keyEvent);
        clicked = true;
        console.log("Gmail Reply Generator: Triggered Reply button (method 3)");
      } catch (e) {
        console.warn("Gmail Reply Generator: Keyboard event failed:", e);
      }
    }
    
    if (!clicked) {
      console.warn("Gmail Reply Generator: All click methods failed");
      return false;
    }
    
    // Wait for the reply editor to appear with longer timeout
    const maxWait = 5000; // 5 seconds max wait
    const checkInterval = 150; // Check every 150ms
    let waited = 0;
    
    while (waited < maxWait) {
      const editor = queryAny([
        "div[aria-label='Message Body']",
        "div[role='textbox'][contenteditable='true'][aria-label*='Message']",
        ".editable.LW-avf.tS-tW",
        "div[contenteditable='true'][aria-label*='Message Body']",
        "div[contenteditable='true'][aria-label*='message']",
        "div[contenteditable='true'][aria-label*='Compose']"
      ]);
      
      if (editor) {
        // Double-check it's actually visible and editable
        const style = window.getComputedStyle(editor);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          console.log("Gmail Reply Generator: Reply editor opened successfully");
          return true;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }
    
    console.warn("Gmail Reply Generator: Reply editor did not open within timeout");
    return false;
  }

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

    // Get button reference and save original text
    const genBtn = document.getElementById("grg-generate-btn");
    const oldText = genBtn ? genBtn.innerText : "Generate Reply";
    
    // Show loading state
    if (genBtn) {
      genBtn.innerText = "Opening reply editor...";
      genBtn.disabled = true;
    }

    // Automatically open the reply editor
    const editorOpened = await openReplyEditor();
    
    if (!editorOpened) {
      // Try one more time after a short delay (Gmail might be loading)
      console.log("Gmail Reply Generator: First attempt failed, retrying...");
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryOpened = await openReplyEditor();
      
      if (!retryOpened) {
        if (genBtn) {
          genBtn.innerText = oldText;
          genBtn.disabled = false;
        }
        alert("Could not open reply editor automatically. Please click Reply manually, then try again.");
        return;
      }
    }

    // Update button text
    if (genBtn) {
      genBtn.innerText = "Extracting email...";
    }
    
    // Small delay to ensure editor is fully loaded
    await new Promise(resolve => setTimeout(resolve, 300));

    // Extract the exact message being replied to at THIS moment
    // This is the critical safety step - we read the email NOW, not earlier
    const original = extractOriginalEmailText();
    if (!original) {
      if (genBtn) {
        genBtn.innerText = oldText;
        genBtn.disabled = false;
      }
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

    // Update button text to show generating
    if (genBtn) {
      genBtn.innerText = "Generating...";
    }

    // Send payload to background to call Gemini
    safeSendMessage({ type: "GENERATE_REPLY", payload: { prompt } }, (response) => {
      // Restore button state
      if (genBtn) {
        genBtn.innerText = oldText;
        genBtn.disabled = false;
      }

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
  let observer = null;
  let lastButtonCheck = 0;
  const BUTTON_CHECK_THROTTLE = 500; // Throttle checks to every 500ms
  
  function setupObserver() {
    // If observer already exists and is connected, don't create a new one
    if (observer) {
      return;
    }
    
    observer = new MutationObserver((mutations) => {
      // Check context validity before attempting to create buttons
      if (!isExtensionContextValid()) {
        // If context is invalidated, disconnect observer but don't recreate
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        return;
      }
      
      // Throttle checks to avoid excessive calls
      const now = Date.now();
      if (now - lastButtonCheck < BUTTON_CHECK_THROTTLE) {
        return;
      }
      lastButtonCheck = now;
      
      // Check if there are actual DOM changes
      let shouldCheck = false;
      let hasSignificantChanges = false;
      
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          shouldCheck = true;
          
          // Check if buttons were removed or if we're switching views
          for (const node of mutation.removedNodes) {
            if (node.nodeType === 1 && (node.id === BUTTON_CONTAINER_ID || node.contains && node.contains(document.getElementById(BUTTON_CONTAINER_ID)))) {
              hasSignificantChanges = true;
              console.log("Gmail Reply Generator: Buttons container removed, recreating...");
              break;
            }
          }
          
          // Check if compose view or email view was added
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              const isCompose = node.querySelector && (
                node.querySelector("div[role='dialog'][aria-label*='Compose']") ||
                node.querySelector("div[aria-label*='Compose']") ||
                node.matches && node.matches("div[role='dialog'][aria-label*='Compose']")
              );
              const isEmail = node.querySelector && (
                node.querySelector("div[data-thread-perm-id]") ||
                node.querySelector("div[role='article']")
              );
              
              if (isCompose || isEmail) {
                hasSignificantChanges = true;
                console.log("Gmail Reply Generator: Email/compose view detected, creating buttons...");
                break;
              }
            }
          }
          
          if (hasSignificantChanges) break;
        }
      }
      
      if (shouldCheck) {
        // Always check if buttons exist when there are changes
        const container = document.getElementById(BUTTON_CONTAINER_ID);
        const isEmail = isEmailView();
        
        if (isEmail && (!container || !document.body.contains(container))) {
          // Buttons should exist but don't, or were removed from DOM
          console.log("Gmail Reply Generator: Buttons missing in email/compose view, recreating...");
          currentThreadId = null; // Reset to force recreation
          createButtons();
        } else if (hasSignificantChanges) {
          // Significant view change detected, recreate buttons
          createButtons();
        }
      }
    });
  }
  
  setupObserver();

  // Start observing once DOM is ready
  function startObserving() {
    if (!observer) {
      setupObserver();
    }
    
    if (document.body && observer) {
      try {
        observer.observe(document.body, { 
          childList: true, 
          subtree: true,
          attributes: false,
          characterData: false
        });
        console.log("Gmail Reply Generator: MutationObserver started");
      } catch (e) {
        console.error("Gmail Reply Generator: Failed to start observer:", e);
      }
    }
  }
  
  if (document.body) {
    startObserving();
  } else {
    // Wait for body to be available
    const bodyObserver = new MutationObserver(() => {
      if (document.body) {
        startObserving();
        bodyObserver.disconnect();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }

  // Also listen for URL changes (Gmail uses pushState for navigation)
  let lastUrl = location.href;
  const urlCheckInterval = setInterval(() => {
    // Check context validity
    if (!isExtensionContextValid()) {
      return;
    }
    
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("Gmail Reply Generator: URL changed, checking for buttons");
      
      // Reset thread ID to force button recreation
      currentThreadId = null;
      
      // URL changed - update button state for new thread
      const container = document.getElementById(BUTTON_CONTAINER_ID);
      if (container) {
        container.remove();
      }
      
      // Try multiple times with increasing delays to catch Gmail's dynamic loading
      setTimeout(() => createButtons(), 100);
      setTimeout(() => createButtons(), 500);
      setTimeout(() => createButtons(), 1000);
      setTimeout(() => createButtons(), 2000);
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
      const result = await safeStorageGet([LOGS_STORAGE_KEY], null, true); // Use sync storage
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
  const maxRetries = 20; // Increased retries
  const retryInterval = setInterval(() => {
    if (retryCount >= maxRetries) {
      clearInterval(retryInterval);
      return;
    }
    
    // Check context validity before attempting any operations
    if (!isExtensionContextValid()) {
      // If context is invalidated, stop retrying
      clearInterval(retryInterval);
      return;
    }
    
    const container = document.getElementById(BUTTON_CONTAINER_ID);
    const isEmail = isEmailView();
    
    if (isEmail && !container) {
      console.log(`Gmail Reply Generator: Retry ${retryCount + 1}/${maxRetries} - attempting to create buttons`);
      createButtons();
      
      // If still no container after creation attempt, log for debugging
      if (!document.getElementById(BUTTON_CONTAINER_ID)) {
        console.log("Gmail Reply Generator: Buttons not created, will retry...");
      }
    } else if (isEmail && container) {
      // Verify container is still in DOM and visible (might have been removed by Gmail)
      if (!document.body.contains(container)) {
        console.log("Gmail Reply Generator: Container removed from DOM, recreating...");
        currentThreadId = null; // Reset to force recreation
        createButtons();
      }
    } else if (!isEmail && container) {
      // Only remove if we're definitely in inbox list (not transitioning between views)
      const isInboxList = !queryAny([
        "div[role='main'] div[role='article']",
        "div[data-thread-perm-id]",
        "div[role='dialog']",
        "div[aria-label*='Compose']"
      ]);
      
      if (isInboxList) {
        container.remove();
        currentThreadId = null; // Reset thread ID
      }
    }
    
    retryCount++;
  }, 500); // Check more frequently (every 500ms instead of 1000ms)

  // Ensure buttons are added at least once on load (with delay for async content)
  setTimeout(() => {
    createButtons();
  }, 500);
  
  // Also try immediately
  createButtons();
  
  // Listen for Gmail's pushState navigation (when clicking emails)
  let lastPath = location.pathname + location.hash;
  const navigationCheck = setInterval(() => {
    const currentPath = location.pathname + location.hash;
    if (currentPath !== lastPath) {
      lastPath = currentPath;
      console.log("Gmail Reply Generator: Navigation detected, recreating buttons");
      
      // Reset thread ID to force recreation
      currentThreadId = null;
      
      // Remove existing buttons
      const existingContainer = document.getElementById(BUTTON_CONTAINER_ID);
      if (existingContainer) {
        existingContainer.remove();
      }
      
      // Try to create buttons with multiple delays
      setTimeout(() => createButtons(), 100);
      setTimeout(() => createButtons(), 500);
      setTimeout(() => createButtons(), 1000);
      setTimeout(() => createButtons(), 2000);
    }
  }, 300);
  
  // Also listen for popstate events (back/forward button)
  window.addEventListener('popstate', () => {
    console.log("Gmail Reply Generator: Popstate event, recreating buttons");
    currentThreadId = null;
    const existingContainer = document.getElementById(BUTTON_CONTAINER_ID);
    if (existingContainer) {
      existingContainer.remove();
    }
    setTimeout(() => createButtons(), 300);
    setTimeout(() => createButtons(), 1000);
  });

  // Listen for logging toggle changes from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "LOGGING_TOGGLE") {
      const enabled = message.enabled;
      loggingEnabled = enabled;
      // Log this action (bypasses the enabled check)
      logLoggingToggle(enabled).catch(err => console.error("Failed to log toggle:", err));
      sendResponse({ ok: true });
    }
    return true; // Indicate async response
  });
})();
