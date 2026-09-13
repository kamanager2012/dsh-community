import React from 'react';
import { Box, Text } from 'ink';
import { type DshUsageMetrics, type DshAgentStatus, DshContextGuard } from '@dsh-community/dsh-bridge';

interface HeaderProps {
  model: string;
  status: DshAgentStatus;
  metrics: DshUsageMetrics;
  workspacePath: string;
}

const contextGuard = new DshContextGuard(75, 90);

export const Header: React.FC<HeaderProps> = ({
  model,
  status,
  metrics,
  workspacePath,
}) => {
  const guardStatus = contextGuard.evaluate(metrics);

  const getStatusColor = (s: DshAgentStatus) => {
    switch (s) {
      case 'idle': return 'green';
      case 'thinking': return 'cyan';
      case 'generating': return 'blue';
      case 'awaiting_approval': return 'yellow';
      case 'executing_tool': return 'magenta';
      case 'interrupted': return 'yellow';
      case 'error': return 'red';
      default: return 'gray';
    }
  };

  const shortPath = workspacePath.length > 30 
    ? `...${workspacePath.slice(-27)}` 
    : workspacePath;

  const headerBorderColor = guardStatus.isCritical ? 'red' : guardStatus.isWarning ? 'yellow' : 'gray';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={headerBorderColor}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">⚡ DeepSeek Harness TUI</Text>
          <Text color="gray">|</Text>
          <Text color="white">Model: </Text>
          <Text bold color="blue">{model}</Text>
        </Box>

        <Box gap={1}>
          <Text color="gray">Status:</Text>
          <Text bold color={getStatusColor(status)}>{status.toUpperCase()}</Text>
        </Box>
      </Box>

      <Box justifyContent="space-between" marginTop={0}>
        <Box gap={1}>
          <Text color="gray">Dir:</Text>
          <Text color="dim">{shortPath}</Text>
        </Box>

        <Box gap={2}>
          <Text color="gray">
            Tokens: <Text color={guardStatus.isCritical ? 'red' : guardStatus.isWarning ? 'yellow' : 'white'}>
              {metrics.totalTokens.toLocaleString()}
            </Text>
            {metrics.contextUsagePercent > 0 && (
              <Text color={guardStatus.isCritical ? 'red' : guardStatus.isWarning ? 'yellow' : 'dim'}>
                {' '}({metrics.contextUsagePercent.toFixed(1)}%)
              </Text>
            )}
          </Text>

          {metrics.tps > 0 && (
            <Text color="green">
              TPS: <Text bold>{metrics.tps.toFixed(1)}</Text>
            </Text>
          )}
        </Box>
      </Box>

      {guardStatus.message && (
        <Box marginTop={0}>
          <Text color={guardStatus.isCritical ? 'red' : 'yellow'} bold>
            {guardStatus.message}
          </Text>
        </Box>
      )}
    </Box>
  );
};
