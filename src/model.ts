export const workloadKinds = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;

export type WorkloadKind = (typeof workloadKinds)[number];

export interface ConnectionOptions {
  context?: string | undefined;
  namespace?: string | undefined;
  kubeconfig?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface WorkloadTarget {
  kind: WorkloadKind;
  name: string;
  container?: string | undefined;
}

export class WorkloadError extends Error {
  constructor(
    readonly code:
      | 'configuration'
      | 'not-found'
      | 'unauthorized'
      | 'forbidden'
      | 'timeout'
      | 'read'
      | 'unsupported'
      | 'value',
    message: string,
  ) {
    super(message);
    this.name = 'WorkloadError';
  }
}

export function parseWorkloadKind(value: string): WorkloadKind {
  const kind = workloadKinds.find((candidate) => candidate === value);
  if (!kind) {
    throw new WorkloadError(
      'configuration',
      `Unsupported workload kind "${value}". Expected ${workloadKinds.join(', ')}.`,
    );
  }
  return kind;
}
