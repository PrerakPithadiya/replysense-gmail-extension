document.addEventListener("DOMContentLoaded", () => {
  const apiBase = document.getElementById("apiBase");
  const apiKey = document.getElementById("apiKey");
  const model = document.getElementById("model");
  const maxTokens = document.getElementById("maxTokens");
  const toneMode = document.getElementById("toneMode");
  const loggingEnabled = document.getElementById("loggingEnabled");
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");
  const downloadLogsBtn = document.getElementById("downloadLogsBtn");

  // Load stored values
  chrome.storage.local.get(["apiBase", "apiKey", "model", "maxTokens", "toneMode"], (res) => {
    if (res.apiBase) apiBase.value = res.apiBase;
    if (res.apiKey) apiKey.value = res.apiKey;
    if (res.model) model.value = res.model;
    if (res.maxTokens) maxTokens.value = res.maxTokens;
    if (res.toneMode) toneMode.value = res.toneMode;
  });

  // Load logging enabled state (from sync storage for persistence)
  chrome.storage.sync.get(["loggingEnabled"], (res) => {
    loggingEnabled.checked = res.loggingEnabled !== false; // Default to true
  });

  // Handle logging toggle change
  loggingEnabled.addEventListener("change", () => {
    const enabled = loggingEnabled.checked;
    chrome.storage.sync.set({ loggingEnabled: enabled }, () => {
      // Notify content script about the change
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "LOGGING_TOGGLE",
            enabled: enabled
          }).catch(() => {
            // Ignore errors if content script isn't ready
          });
        }
      });
    });
  });

  saveBtn.addEventListener("click", () => {
    const toSave = {
      apiBase: apiBase.value.trim(),
      apiKey: apiKey.value.trim(),
      model: model.value,
      maxTokens: parseInt(maxTokens.value, 10) || 4096,
      toneMode: toneMode.value
    };
    chrome.storage.local.set(toSave, () => {
      // Also save logging state
      chrome.storage.sync.set({ loggingEnabled: loggingEnabled.checked }, () => {
        alert("Settings saved locally.");
        // clear password field visually but keep it in storage
        apiKey.value = "••••••••";
        setTimeout(() => apiKey.value = "", 400);
      });
    });
  });

  clearBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["apiKey"], () => {
      alert("API key cleared from storage.");
      apiKey.value = "";
    });
  });

  downloadLogsBtn.addEventListener("click", () => {
    // Send message to background to download logs
    chrome.runtime.sendMessage({ type: "DOWNLOAD_LOGS" }, (response) => {
      if (chrome.runtime.lastError) {
        alert("Error downloading logs: " + chrome.runtime.lastError.message);
      } else if (response && response.ok) {
        alert("Logs downloaded successfully!");
      } else {
        alert("Error downloading logs: " + (response?.error || "Unknown error"));
      }
    });
  });
});

