document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const workspacePathInput = document.getElementById('workspacePath');
  const runtimeVersionSelect = document.getElementById('runtimeVersion');
  const sandboxModeSelect = document.getElementById('sandboxMode');
  const saveBtn = document.getElementById('save-btn');
  const runtimeBadge = document.getElementById('runtime-badge');
  const logsOutput = document.getElementById('logs-output');

  // Load existing config
  if (window.dshDesktop) {
    const config = await window.dshDesktop.getConfig();
    if (config) {
      if (config.apiKey) apiKeyInput.value = config.apiKey;
      if (config.model) modelSelect.value = config.model;
      if (config.workspacePath) workspacePathInput.value = config.workspacePath;
      if (config.runtimeVersion && runtimeVersionSelect) runtimeVersionSelect.value = config.runtimeVersion;
      if (config.sandboxMode) sandboxModeSelect.value = config.sandboxMode;
    }
  }

  // Handle Save
  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      alert('DeepSeek API Key is required.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.innerText = 'Saving & Restarting Runtime...';

    if (window.dshDesktop) {
      await window.dshDesktop.saveConfig({
        apiKey,
        model: modelSelect.value,
        workspacePath: workspacePathInput.value.trim() || undefined,
        runtimeVersion: runtimeVersionSelect ? runtimeVersionSelect.value : undefined,
        sandboxMode: sandboxModeSelect.value,
      });
    }

    saveBtn.disabled = false;
    saveBtn.innerText = 'Saved!';
    setTimeout(() => {
      saveBtn.innerText = 'Save & Launch Harness';
    }, 2000);
  });

  // Diagnostic Poll
  async function refreshDiagnostics() {
    if (!window.dshDesktop) return;

    try {
      const health = await window.dshDesktop.getRuntimeHealth();
      if (health && health.running) {
        runtimeBadge.className = 'badge running';
        runtimeBadge.innerText = `Running (Port ${health.port || 3080})`;
      } else {
        runtimeBadge.className = 'badge stopped';
        runtimeBadge.innerText = 'Stopped';
      }

      const logs = await window.dshDesktop.getRuntimeLogs();
      if (logs && logs.length > 0) {
        logsOutput.innerText = logs.join('\n');
        logsOutput.parentElement.scrollTop = logsOutput.parentElement.scrollHeight;
      }

      const sessions = await window.dshDesktop.listSessions();
      const sessionsCount = document.getElementById('sessions-count');
      const sessionsList = document.getElementById('sessions-list');

      if (sessions && sessionsList) {
        sessionsCount.innerText = `${sessions.length} Sessions`;
        if (sessions.length === 0) {
          sessionsList.innerHTML = '<li class="empty-sessions">No sessions found in ~/.dsh/sessions</li>';
        } else {
          sessionsList.innerHTML = '';
          sessions.slice(0, 8).forEach(s => {
            const li = document.createElement('li');
            li.className = 'session-item';
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'session-title';
            titleSpan.textContent = s.title;
            
            const metaSpan = document.createElement('span');
            metaSpan.className = 'session-meta';
            metaSpan.textContent = `${s.model} • ${s.messageCount} msgs`;
            
            li.appendChild(titleSpan);
            li.appendChild(metaSpan);
            sessionsList.appendChild(li);
          });
        }
      }
    } catch (err) {
      console.error('Diagnostics refresh failed:', err);
    }
  }

  setInterval(refreshDiagnostics, 1500);
  refreshDiagnostics();
});
