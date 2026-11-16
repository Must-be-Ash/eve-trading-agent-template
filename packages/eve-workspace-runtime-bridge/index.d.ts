interface NodeTargetedWorkflowRuntime {
  createSession(input: unknown): Promise<unknown>;
}

export declare function createNodeTargetedWorkflowRuntime(config: {
  readonly dynamicSubagentAgentConfig?: {
    readonly description: string;
    readonly limits?: {
      readonly sessionTimeoutMs?: number | false;
    };
    readonly model: { readonly id: string };
    readonly reasoning?: "minimal" | "low" | "medium" | "high";
  };
  readonly nodeId: string;
}): NodeTargetedWorkflowRuntime;
