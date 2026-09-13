import React from 'react';
import { Box, Text } from 'ink';

interface DiffViewerProps {
  diffText: string;
  maxLines?: number;
}

/**
 * High-performance Terminal Unified Diff Renderer with syntax coloring
 * Surpasses standard plain-text tool outputs with rich Claude Code style diff cards.
 */
export const DiffViewer: React.FC<DiffViewerProps> = ({ diffText, maxLines = 15 }) => {
  if (!diffText) return null;

  const lines = diffText.split('\n');
  const displayLines = lines.slice(0, maxLines);
  const truncatedCount = lines.length - displayLines.length;

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1} borderStyle="single" borderColor="gray">
      {displayLines.map((line, idx) => {
        let color: string = 'white';
        let isBold = false;

        if (line.startsWith('+++') || line.startsWith('---')) {
          isBold = true;
        } else if (line.startsWith('+')) {
          color = 'green';
        } else if (line.startsWith('-')) {
          color = 'red';
        } else if (line.startsWith('@@')) {
          color = 'cyan';
        }

        return (
          <Box key={idx} gap={1}>
            <Text color={color} bold={isBold}>
              {line}
            </Text>
          </Box>
        );
      })}

      {truncatedCount > 0 && (
        <Box marginTop={0}>
          <Text color="dim" italic>
            ... and {truncatedCount} more diff lines (truncated for terminal ergonomics)
          </Text>
        </Box>
      )}
    </Box>
  );
};
