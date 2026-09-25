import type { AvailabilityStatus, IncidentStatus, TeamId } from '../api/types';
import { AVAILABILITY_STATUS_LABELS, INCIDENT_STATUS_LABELS } from '../lib/labels';

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge badge-status-${status}`}>{INCIDENT_STATUS_LABELS[status]}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone = severity === 'critical' ? 'critical' : severity === 'high' ? 'high' : 'other';
  return <span className={`badge badge-sev-${tone}`}>{severity}</span>;
}

export function TeamBadge({ team }: { team: TeamId }) {
  return <span className={`badge badge-team-${team}`}>{team}</span>;
}

export function AvailabilityBadge({ status }: { status: AvailabilityStatus }) {
  return <span className={`badge badge-avail-${status}`}>{AVAILABILITY_STATUS_LABELS[status]}</span>;
}
