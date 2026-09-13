import React from 'react';
import { Box, useInput } from 'ink';
import { DshAgentController, DshSharedSessionStore } from '@dsh-community/dsh-bridge';
import { useTuiBridge } from './adapter/tui-adapter.js';
import { Header } from './views/Header.js';
import { MessageList } from './views/MessageList.js';
import { ReasoningBox } from './views/ReasoningBox.js';
import { ApprovalPrompt } from './views/ApprovalPrompt.js';
import { InputBar } from './views/InputBar.js';

interface AppProps {
  controller: DshAgentController;
}

export const App: React.FC<AppProps> = ({ controller }) => {
  const {
    session,
    status,
    currentReasoning,
    currentContent,
    pendingApproval,
    metrics,
    submitPrompt,
    respondApproval,
    interrupt,
    rollback,
  } = useTuiBridge(controller);

  // Global keyboard shortcuts (e.g. Esc to interrupt)
  useInput((_, key) => {
    if (key.escape && status !== 'idle' && !pendingApproval) {
      interrupt();
    }
  });

  const handleCommandOrPrompt = async (text: string) => {
    if (text.startsWith('/help')) {
      const helpText = `Available commands:
  /help       - Show this help message
  /rollback   - Rollback the session
  /fork       - Fork the current session
  /sessions   - List available sessions
  /resume     - Resume a session
  /save       - Save current session
  /doctor     - Run system diagnostics
  /plugins    - Search marketplace plugins
  /audit      - View security audit chain
  /provider   - Manage LLM providers
  /undo       - Undo last mutation
  /export     - Export session transcript
  /exit       - Exit the application`;
      controller.addSystemMessage(helpText);
      return;
    }

    if (text.startsWith('/rollback')) {
      const parts = text.split(' ');
      const targetIndex = parts[1] ? parseInt(parts[1], 10) : session.messages.length - 2;
      if (!isNaN(targetIndex) && targetIndex >= 0) {
        rollback(targetIndex);
      }
      return;
    }

    if (text.startsWith('/fork')) {
      controller.forkSession(session.messages.length);
      return;
    }

    if (text.startsWith('/sessions')) {
      const store = new DshSharedSessionStore();
      const list = store.listSessions();
      const summaryText = list.length === 0 
        ? 'No past sessions found in ~/.dsh/suite_sessions or ~/.dsh/sessions' 
        : `Recent sessions (Suite & Official Read-Only):\n` + list.slice(0, 5).map(s => `  • ${s.id} - ${s.title} (${s.isOfficial ? 'Official' : `${s.messageCount} msgs`}, ${s.model})`).join('\n') + `\n\nUse /resume <id> to resume.`;
      
      controller.addSystemMessage(summaryText);
      return;
    }

    if (text.startsWith('/resume')) {
      const parts = text.split(' ');
      const targetId = parts[1]?.trim();
      if (!targetId) {
        controller.addSystemMessage('Usage: /resume <session_id>');
        return;
      }

      controller.resumeSessionById(targetId);
      return;
    }

    if (text.startsWith('/save')) {
      controller.saveCurrentSession();
      return;
    }

    if (text.startsWith('/doctor')) {
      const report = controller.diagnose();
      const reportText = controller.formatDoctorReport(report);
      controller.addSystemMessage(reportText);
      return;
    }

    if (text.startsWith('/plugins')) {
      const parts = text.split(' ');
      const query = parts.slice(1).join(' ').trim();
      const plugins = await controller.searchPlugins(query);
      const outputText = controller.formatPluginList(plugins);
      controller.addSystemMessage(outputText);
      return;
    }

    if (text.startsWith('/audit')) {
      const records = controller.auditChain.getRecords();
      const verifyResult = controller.auditChain.verify();
      const auditText = records.length === 0
        ? 'No tool executions or security decisions recorded yet in this session.'
        : `🛡️ Tamper-Evident Audit Chain (${records.length} records, Integrity: ${verifyResult.valid ? '✅ VERIFIED' : '❌ CORRUPTED'}):\n\n` +
          records.slice(-5).map(r => `[#${r.seq} | ${new Date(r.timestamp).toISOString().slice(11, 19)}] ${r.toolName} -> ${r.verdict ?? r.status ?? 'recorded'} (${r.riskLevel.toUpperCase()}) | SHA: ${r.hash.slice(0, 12)}...`).join('\n');
      
      controller.addSystemMessage(auditText);
      return;
    }

    if (text.startsWith('/provider')) {
      const parts = text.split(' ');
      if (parts[1] === 'switch' && parts[2]) {
        const res = controller.switchProvider(parts[2], parts[3]);
        controller.addSystemMessage(res.message);
      } else {
        controller.addSystemMessage(controller.listProviders());
      }
      return;
    }

    if (text.startsWith('/undo')) {
      const res = controller.undoLastMutation();
      controller.addSystemMessage(res.message);
      return;
    }

    if (text.startsWith('/export')) {
      const parts = text.split(' ');
      const format = parts[1] === 'json' ? 'json' : 'markdown';
      const output = controller.exportTranscript(format);
      controller.addSystemMessage(`📄 Exported Session Transcript (${format.toUpperCase()}):\n\n${output.slice(0, 500)}...\n\n[Full transcript ready]`);
      return;
    }

    await submitPrompt(text);
  };

  const isWorking = status !== 'idle' && status !== 'error';

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header
        model={session.model}
        status={status}
        metrics={metrics}
        workspacePath={session.workspacePath}
      />

      <MessageList
        messages={session.messages}
        currentContent={currentContent}
      />

      <ReasoningBox
        reasoning={currentReasoning}
        isStreaming={status === 'thinking' || status === 'generating'}
      />

      {pendingApproval && (
        <ApprovalPrompt
          approval={pendingApproval}
          onDecision={respondApproval}
        />
      )}

      <InputBar
        onSubmit={handleCommandOrPrompt}
        onInterrupt={interrupt}
        disabled={isWorking && !pendingApproval}
      />
    </Box>
  );
};
