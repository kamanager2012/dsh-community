import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { DshToolCall } from '@dsh-community/dsh-bridge';
import { DiffViewer } from './DiffViewer.js';

interface ToolCardProps {
  toolCall: DshToolCall;
}

export const ToolCard: React.FC<ToolCardProps> = ({ toolCall }) => {
  const isRunning = toolCall.status === 'running';
  const isSuccess = toolCall.status === 'success';
  const isFailed = toolCall.status === 'failed';

  const borderColor = isRunning ? 'yellow' : isSuccess ? 'green' : isFailed ? 'red' : 'gray';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          {isRunning && (
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
          )}
          <Text bold color="yellow">Tool: {toolCall.name}</Text>
        </Box>
        <Text color={borderColor}>[{toolCall.status.toUpperCase()}]</Text>
      </Box>

      {toolCall.args && Object.keys(toolCall.args).length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="dim">Arguments:</Text>
          <Text color="gray">
            {JSON.stringify(toolCall.args, null, 2)}
          </Text>
        </Box>
      )}

      {toolCall.diff && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">Code Changes (Diff):</Text>
          <DiffViewer diffText={toolCall.diff} />
        </Box>
      )}

      {toolCall.output && (
        <Box marginTop={1} flexDirection="column">
          <Text color="dim">Output:</Text>
          <Text color="white">
            {toolCall.output.length > 200 
              ? `${toolCall.output.slice(0, 200)}...` 
              : toolCall.output}
          </Text>
        </Box>
      )}

      {toolCall.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {toolCall.error}</Text>
        </Box>
      )}
    </Box>
  );
};
