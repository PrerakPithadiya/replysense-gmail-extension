document.addEventListener("DOMContentLoaded", () => {
  const apiBase = document.getElementById("apiBase");
  const apiKey = document.getElementById("apiKey");
  const model = document.getElementById("model");
  const maxTokens = document.getElementById("maxTokens");
  const toneMode = document.getElementById("toneMode");
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");
  const clearLogsBtn = document.getElementById("clearLogsBtn");
  const logsContainer = document.getElementById("logsContainer");

  // Tab switching
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");
  
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      
      // Update buttons
      tabButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      // Update content
      tabContents.forEach(c => c.classList.remove("active"));
      document.getElementById(`${targetTab}-tab`).classList.add("active");
      
      // Load logs when switching to logs tab
      if (targetTab === "logs") {
        loadLogs();
      }
    });
  });

  // Load stored values
  chrome.storage.local.get(["apiBase", "apiKey", "model", "maxTokens", "toneMode"], (res) => {
    if (res.apiBase) apiBase.value = res.apiBase;
    if (res.apiKey) apiKey.value = res.apiKey;
    if (res.model) model.value = res.model;
    if (res.maxTokens) maxTokens.value = res.maxTokens;
    if (res.toneMode) toneMode.value = res.toneMode;
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
      alert("Settings saved locally.");
      // clear password field visually but keep it in storage
      apiKey.value = "••••••••";
      setTimeout(() => apiKey.value = "", 400);
    });
  });

  clearBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["apiKey"], () => {
      alert("API key cleared from storage.");
      apiKey.value = "";
    });
  });

  // Load and display logs (categorized)
  function loadLogs() {
    chrome.storage.local.get(["grg_logs"], (res) => {
      const logs = res.grg_logs || [];
      
      if (logs.length === 0) {
        logsContainer.innerHTML = '<p style="text-align: center; color: #666; margin: 20px 0;">No logs yet. Activity will appear here.</p>';
        return;
      }
      
      // Separate logs by type
      const extensionLogs = logs.filter(log => log.type === 'extension');
      const replyLogs = logs.filter(log => log.type === 'reply');
      
      let html = '';
      
      // Extension Logs Section
      if (extensionLogs.length > 0) {
        html += '<div style="margin-bottom: 20px;"><h4 style="margin: 0 0 10px 0; font-size: 14px; color: #333; font-weight: bold;">Extension Logs</h4>';
        html += extensionLogs.map(log => {
          const actionLabel = {
            'enabled': 'Extension Enabled',
            'disabled': 'Extension Disabled'
          }[log.action] || log.action;
          
          const typeClass = `extension-${log.action}`;
          const icon = {
            'enabled': '✓',
            'disabled': '✗'
          }[log.action] || '•';
          
          return `
            <div class="log-entry ${typeClass}" style="margin-bottom: 8px;">
              <div class="log-time">${log.date} at ${log.time}</div>
              <div class="log-action">${icon} ${actionLabel}</div>
              ${log.details && log.details.threadId ? `<div class="log-details">Thread: ${log.details.threadId.substring(0, 20)}...</div>` : ''}
            </div>
          `;
        }).join('');
        html += '</div>';
      }
      
      // Reply Logs Section
      if (replyLogs.length > 0) {
        html += '<div><h4 style="margin: 0 0 10px 0; font-size: 14px; color: #333; font-weight: bold;">Reply Logs</h4>';
        html += replyLogs.map(log => {
          const actionLabel = {
            'generated': 'Reply Generated',
            'accepted': 'Reply Accepted',
            'rejected': 'Reply Rejected'
          }[log.action] || log.action;
          
          const typeClass = `reply-${log.action}`;
          const icon = {
            'generated': '⚡',
            'accepted': '✓',
            'rejected': '✗'
          }[log.action] || '•';
          
          let detailsText = '';
          if (log.details) {
            const parts = [];
            if (log.details.replyLength) parts.push(`Length: ${log.details.replyLength} chars`);
            if (log.details.threadId) parts.push(`Thread: ${log.details.threadId.substring(0, 15)}...`);
            if (parts.length > 0) detailsText = parts.join(' • ');
          }
          
          return `
            <div class="log-entry ${typeClass}" style="margin-bottom: 8px;">
              <div class="log-time">${log.date} at ${log.time}</div>
              <div class="log-action">${icon} ${actionLabel}</div>
              ${detailsText ? `<div class="log-details">${detailsText}</div>` : ''}
            </div>
          `;
        }).join('');
        html += '</div>';
      }
      
      if (html === '') {
        html = '<p style="text-align: center; color: #666; margin: 20px 0;">No logs yet. Activity will appear here.</p>';
      }
      
      logsContainer.innerHTML = html;
    });
  }

  // Clear all logs
  clearLogsBtn.addEventListener("click", () => {
    if (confirm("Are you sure you want to clear all logs? This action cannot be undone.")) {
      chrome.storage.local.set({ grg_logs: [] }, () => {
        loadLogs();
        alert("All logs cleared.");
      });
    }
  });

  // Load logs on initial page load if on logs tab
  if (document.getElementById("logs-tab").classList.contains("active")) {
    loadLogs();
  }
});

