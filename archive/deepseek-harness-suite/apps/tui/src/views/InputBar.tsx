import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  disabled?: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({
  onSubmit,
  onInterrupt,
  disabled = false,
}) => {
  const [value, setValue] = useState('');

  const { exit } = useApp();

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === '/exit' || trimmed === '/quit') {
      exit();
      return;
    }

    onSubmit(trimmed);
    setValue('');
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={disabled ? 'gray' : 'cyan'}
      paddingX={1}
      marginTop={1}
    >
      <Box gap={1}>
        <Text bold color="cyan">❯</Text>
        {disabled ? (
          <Text color="dim">Agent is working... (Press Esc to cancel)</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Type your message or /help... (Enter to send)"
          />
        )}
      </Box>
      <Box marginTop={0}>
        <Text color="dim" italic>
          Tip: Type /rollback, /fork, /exit, or ask questions directly
        </Text>
      </Box>
    </Box>
  );
};
