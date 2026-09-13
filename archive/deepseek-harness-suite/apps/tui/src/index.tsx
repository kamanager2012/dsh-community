#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { DshAgentController, DshSharedSessionStore } from '@dsh-community/dsh-bridge';
import { App } from './App.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let model = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
  let workspacePath = process.cwd();
  let resumeSession: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
DeepSeek Harness TUI (dsh-tui) - Claude Code level Terminal UX

Usage:
  dsh-tui [options]

Options:
  --model <model>       Model to use (default: deepseek-reasoner or $DEEPSEEK_MODEL)
  --dir <path>          Workspace directory (default: current working directory)
  -r, --resume <id>     Resume previous session by ID, or pass 'last' for latest session
  -h, --help            Show this help message
  -v, --version         Show version information

In-session Commands:
  /doctor               Run five-layer system and environment health diagnostics
  /plugins [search]     Browse and discover verified plugins from community marketplace
  /audit                Inspect cryptographic SHA-256 tamper-evident execution audit chain
  /provider [switch]    Inspect or switch model provider (DeepSeek, SiliconFlow, Ollama, etc.)
  /undo                 Roll back the latest file modification checkpoint
  /export [md|json]     Export structured conversation report
  /sessions             List sessions from store
  /resume <id>          Resume a past session
  /save                 Save current session atomically
  /rollback [index]     Rewind conversation turns
  /fork                 Branch conversation from current turn
  /exit, /quit          Exit TUI
      `);
      process.exit(0);
    } else if (args[i] === '--version' || args[i] === '-v') {
      console.log('dsh-tui v0.1.0 (@dsh-community/tui)');
      process.exit(0);
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--dir' && args[i + 1]) {
      workspacePath = args[i + 1];
      i++;
    } else if ((args[i] === '--resume' || args[i] === '-r') && args[i + 1]) {
      resumeSession = args[i + 1];
      i++;
    }
  }

  return { model, workspacePath, resumeSession };
}

function restoreTerminal() {
  // Ensure terminal cursor is restored and alternate screen is exited
  process.stdout.write('\u001B[?25h');
}

async function main() {
  const { model, workspacePath, resumeSession } = parseArgs();

  const controller = new DshAgentController({
    config: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      model,
      workspacePath,
    },
  });

  if (resumeSession) {
    if (resumeSession === 'last') {
      const store = new DshSharedSessionStore();
      const list = store.listSessions();
      if (list.length > 0) {
        controller.resumeSessionById(list[0].id);
      } else {
        controller.addSystemMessage('No previous sessions found to resume.');
      }
    } else {
      controller.resumeSessionById(resumeSession);
    }
  }

  const cleanup = () => {
    controller.interrupt();
    restoreTerminal();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  process.on('exit', () => {
    restoreTerminal();
  });

  const { waitUntilExit } = render(<App controller={controller} />, {
    exitOnCtrlC: true,
  });

  try {
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  restoreTerminal();
  console.error('Fatal TUI error:', err);
  process.exit(1);
});
