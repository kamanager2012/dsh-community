import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { DshApprovalRequest, DshApprovalDecision } from '@dsh-community/dsh-bridge';

interface ApprovalPromptProps {
  approval: DshApprovalRequest;
  onDecision: (decision: DshApprovalDecision) => void;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({
  approval,
  onDecision,
}) => {
  useInput((input, key) => {
    const char = input.toLowerCase();
    if (char === 'y') {
      onDecision('allow_once');
    } else if (char === 'a') {
      onDecision('allow_always');
    } else if (char === 'n' || key.escape) {
      onDecision('reject');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="red"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="red">
        ⚠️ Tool Permission Requested (Risk: {approval.riskLevel.toUpperCase()})
      </Text>
      <Box marginY={1}>
        <Text color="yellow">{approval.promptMessage}</Text>
      </Box>
      <Box gap={2}>
        <Text bold color="green">[y] Allow Once</Text>
        <Text bold color="cyan">[a] Allow Always</Text>
        <Text bold color="red">[n / Esc] Reject</Text>
      </Box>
    </Box>
  );
};
