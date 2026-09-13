import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface ReasoningBoxProps {
  reasoning: string;
  isStreaming: boolean;
}

export const ReasoningBox: React.FC<ReasoningBoxProps> = ({
  reasoning,
  isStreaming,
}) => {
  if (!reasoning && !isStreaming) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginY={1}
    >
      <Box gap={1}>
        {isStreaming && (
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        )}
        <Text italic bold color="dim">
          DeepSeek Reasoning Stream
        </Text>
      </Box>

      {reasoning ? (
        <Box marginTop={1}>
          <Text color="gray" italic>
            {reasoning}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
