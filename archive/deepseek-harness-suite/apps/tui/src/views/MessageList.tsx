import React from 'react';
import { Box, Text } from 'ink';
import type { DshMessage } from '@dsh-community/dsh-bridge';
import { ToolCard } from './ToolCard.js';

interface MessageListProps {
  messages: DshMessage[];
  currentContent?: string;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  currentContent,
}) => {
  return (
    <Box flexDirection="column" marginY={1}>
      {messages.map((msg, index) => {
        const isUser = msg.role === 'user';
        const isSystem = msg.role === 'system';
        return (
          <Box key={msg.id || index} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text bold color={isSystem ? 'yellow' : (isUser ? 'cyan' : 'green')}>
                {isSystem ? '⚙ System' : (isUser ? '❯ User' : '◆ Assistant')}:
              </Text>
            </Box>
            <Box paddingLeft={2} marginTop={0} flexDirection="column">
              <Text color={isSystem ? 'dim' : 'white'}>{msg.content}</Text>
              {msg.toolCalls?.map((tc) => (
                <ToolCard key={tc.id} toolCall={tc} />
              ))}
            </Box>
          </Box>
        );
      })}

      {currentContent ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">◆ Assistant (streaming):</Text>
          <Box paddingLeft={2}>
            <Text color="white">{currentContent}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
};
