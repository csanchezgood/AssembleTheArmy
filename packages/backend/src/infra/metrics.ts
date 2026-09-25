// CloudWatch Embedded Metric Format (EMF) publisher. Only used for configuration errors so the
// alarm "no_roster" in Terraform can fire. Namespace: AssembleTheArmy/ConfigErrors, metric name
// ConfigErrors (Count), dimension Reason.

export const CONFIG_ERRORS_NAMESPACE = 'AssembleTheArmy/ConfigErrors';
export const CONFIG_ERRORS_METRIC = 'ConfigErrors';

export type ConfigErrorReason = 'no_roster' | 'no_severity_rule' | 'invalid_join_url' | 'graph_config';

export function emitConfigError(reason: ConfigErrorReason, properties: Record<string, unknown> = {}, write: (line: string) => void = defaultWrite): void {
  const doc = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: CONFIG_ERRORS_NAMESPACE,
          Dimensions: [['Reason']],
          Metrics: [{ Name: CONFIG_ERRORS_METRIC, Unit: 'Count' }],
        },
      ],
    },
    Reason: reason,
    [CONFIG_ERRORS_METRIC]: 1,
    ...properties,
  };
  write(JSON.stringify(doc));
}

function defaultWrite(line: string): void {
  process.stdout.write(line + '\n');
}
