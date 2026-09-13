import { useEffect, useState } from 'react';
import { 
  DshAgentController, 
  DshEventStream,
  type DshSession, 
  type DshAgentStatus, 
  type DshApprovalRequest,
  type DshApprovalDecision,
  type DshUsageMetrics
} from '@dsh-community/dsh-bridge';

export interface UseTuiBridgeReturn {
  session: DshSession;
  status: DshAgentStatus;
  currentReasoning: string;
  currentContent: string;
  pendingApproval: DshApprovalRequest | null;
  metrics: DshUsageMetrics;
  submitPrompt: (text: string) => Promise<void>;
  respondApproval: (decision: DshApprovalDecision) => void;
  interrupt: () => void;
  rollback: (turnIndex: number) => void;
}

export function useTuiBridge(controller: DshAgentController): UseTuiBridgeReturn {
  const [session, setSession] = useState<DshSession>(controller.getSession());
  const [status, setStatus] = useState<DshAgentStatus>(controller.getStatus());
  const [currentReasoning, setCurrentReasoning] = useState<string>('');
  const [currentContent, setCurrentContent] = useState<string>('');
  const [pendingApproval, setPendingApproval] = useState<DshApprovalRequest | null>(null);
  const [metrics, setMetrics] = useState<DshUsageMetrics>(session.metrics);

  useEffect(() => {
    const unsubEvent = controller.events.onEvent((event) => {
      switch (event.type) {
        case 'agent:status':
          setStatus(event.status);
          if (event.status === 'idle' || event.status === 'error' || event.status === 'interrupted') {
            setCurrentReasoning('');
            setCurrentContent('');
          }
          break;

        case 'stream:reasoning':
          setCurrentReasoning(event.fullContent);
          break;

        case 'stream:content':
          setCurrentContent(event.fullContent);
          break;

        case 'stream:metrics':
          setMetrics((prev) => ({ ...prev, ...event.metrics }));
          break;

        case 'tool:approval_needed':
          setPendingApproval(event.approval);
          break;

        case 'session:updated':
          setSession({ ...event.session });
          break;

        case 'tool:finished':
          setPendingApproval(null);
          break;
      }
    });

    return () => {
      unsubEvent();
    };
  }, [controller]);

  const submitPrompt = async (text: string) => {
    setCurrentReasoning('');
    setCurrentContent('');
    await controller.submitPrompt(text);
  };

  const respondApproval = (decision: DshApprovalDecision) => {
    if (pendingApproval) {
      controller.respondApproval(pendingApproval.id, decision);
      setPendingApproval(null);
    }
  };

  const interrupt = () => {
    controller.interrupt();
    setPendingApproval(null);
    setCurrentReasoning('');
    setCurrentContent('');
  };

  const rollback = (turnIndex: number) => {
    controller.rollback(turnIndex);
  };

  return {
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
  };
}
