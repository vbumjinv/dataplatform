import { createContext, useContext } from "react";

interface WorkflowActions {
  onRunNode: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onOpenNodeMenu: (nodeId: string, position: { x: number; y: number }) => void;
}

const WorkflowContext = createContext<WorkflowActions | null>(null);

export const WorkflowProvider = ({
  children,
  value,
}: {
  children: React.ReactNode;
  value: WorkflowActions;
}) => {
  return (
    <WorkflowContext.Provider value={value}>
      {children}
    </WorkflowContext.Provider>
  );
};

export const useWorkflowActions = () => {
  const ctx = useContext(WorkflowContext);
  if (!ctx) {
    throw new Error("WorkflowContext가 설정되지 않았습니다.");
  }
  return ctx;
};
