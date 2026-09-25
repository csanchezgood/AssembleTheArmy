// DynamoDB DocumentClient factory and repositories for the five tables of ARCHITECTURE.md section 2.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type {
  AuditEvent,
  AvailabilityItem,
  Incident,
  IncidentStatus,
  LockItem,
  RosterItem,
  SeverityRule,
  TeamId,
} from '../domain/types.js';
import { commonEnv } from './env.js';

let docClient: DynamoDBDocumentClient | undefined;

export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
  }
  return docClient;
}

/** Test hook: replace the shared client. */
export function setDocClient(client: DynamoDBDocumentClient | undefined): void {
  docClient = client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function pad3(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(3, '0');
}

export function rosterKey(teamId: TeamId, priorityOrder: number, memberId: string): string {
  return `${teamId}#${pad3(priorityOrder)}#${memberId}`;
}

export function incidentPk(incidentId: string): string {
  return `INC#${incidentId}`;
}

export function lockPk(systemId: string): string {
  return `LOCK#${systemId}`;
}

export const META_SK = 'META';

interface UpdateParts {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/** Builds SET/REMOVE expressions from a patch: `null` removes the attribute, `undefined` is ignored. */
export function buildUpdate(patch: Record<string, unknown>): UpdateParts | undefined {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let i = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const nameKey = `#a${i}`;
    names[nameKey] = key;
    if (value === null) {
      removes.push(nameKey);
    } else {
      const valueKey = `:v${i}`;
      values[valueKey] = value;
      sets.push(`${nameKey} = ${valueKey}`);
    }
    i += 1;
  }
  if (sets.length === 0 && removes.length === 0) return undefined;
  const parts: string[] = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);
  const out: UpdateParts = { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names };
  if (Object.keys(values).length) out.ExpressionAttributeValues = values;
  return out;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export class RosterRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async listBySystem(systemId: string): Promise<RosterItem[]> {
    return queryAll<RosterItem>(this.client, {
      TableName: this.table,
      KeyConditionExpression: 'system_id = :s',
      ExpressionAttributeValues: { ':s': systemId },
    });
  }

  async listBySystemAndTeam(systemId: string, teamId: TeamId): Promise<RosterItem[]> {
    return queryAll<RosterItem>(this.client, {
      TableName: this.table,
      KeyConditionExpression: 'system_id = :s AND begins_with(roster_key, :t)',
      ExpressionAttributeValues: { ':s': systemId, ':t': `${teamId}#` },
    });
  }

  async listByMember(memberId: string): Promise<RosterItem[]> {
    return queryAll<RosterItem>(this.client, {
      TableName: this.table,
      IndexName: 'by_member',
      KeyConditionExpression: 'member_id = :m',
      ExpressionAttributeValues: { ':m': memberId },
    });
  }

  /** Full scan (projection) used by GET /admin/systems. Small table by design (20 systems). */
  async scanAll(): Promise<RosterItem[]> {
    return scanAll<RosterItem>(this.client, { TableName: this.table });
  }

  async put(item: RosterItem): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async delete(systemId: string, key: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { system_id: systemId, roster_key: key } }));
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export class AvailabilityRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async listByMember(memberId: string): Promise<AvailabilityItem[]> {
    return queryAll<AvailabilityItem>(this.client, {
      TableName: this.table,
      KeyConditionExpression: 'member_id = :m',
      ExpressionAttributeValues: { ':m': memberId },
    });
  }

  /** Loads the records of several members in one go (one query per member, in parallel). */
  async listByMembers(memberIds: Iterable<string>): Promise<Map<string, AvailabilityItem[]>> {
    const ids = [...new Set(memberIds)];
    const results = await Promise.all(ids.map((id) => this.listByMember(id)));
    const map = new Map<string, AvailabilityItem[]>();
    ids.forEach((id, i) => map.set(id, results[i] ?? []));
    return map;
  }

  async scanAll(): Promise<AvailabilityItem[]> {
    return scanAll<AvailabilityItem>(this.client, { TableName: this.table });
  }

  async put(item: AvailabilityItem): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async delete(memberId: string, validFrom: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { member_id: memberId, valid_from: validFrom } }));
  }
}

// ---------------------------------------------------------------------------
// Severity rules
// ---------------------------------------------------------------------------

export class SeverityRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async get(severity: string): Promise<SeverityRule | undefined> {
    const res = await this.client.send(new GetCommand({ TableName: this.table, Key: { severity } }));
    return res.Item as SeverityRule | undefined;
  }

  async scanAll(): Promise<SeverityRule[]> {
    return scanAll<SeverityRule>(this.client, { TableName: this.table });
  }

  async put(item: SeverityRule): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async delete(severity: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { severity } }));
  }
}

// ---------------------------------------------------------------------------
// Incidents + locks
// ---------------------------------------------------------------------------

type IncidentRecord = Incident & { pk: string; sk: string };

function stripKeys(record: Record<string, unknown> | undefined): Incident | undefined {
  if (!record) return undefined;
  const { pk: _pk, sk: _sk, ...rest } = record as unknown as IncidentRecord;
  return rest as Incident;
}

export interface IncidentListOptions {
  limit?: number;
  cursor?: string;
  status?: IncidentStatus;
}

export class IncidentsRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async get(incidentId: string): Promise<Incident | undefined> {
    const res = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk: incidentPk(incidentId), sk: META_SK } }));
    return stripKeys(res.Item);
  }

  async put(incident: Incident): Promise<void> {
    const item: IncidentRecord = { ...incident, pk: incidentPk(incident.incident_id), sk: META_SK };
    await this.client.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /** Partial update; `null` values remove attributes. Returns the updated incident. */
  async update(incidentId: string, patch: Partial<Record<keyof Incident, unknown>>): Promise<Incident | undefined> {
    const parts = buildUpdate(patch);
    if (!parts) return this.get(incidentId);
    const res = await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: incidentPk(incidentId), sk: META_SK },
        ...parts,
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys(res.Attributes);
  }

  /** Atomic echo counter increment. */
  async recordEcho(incidentId: string, lastAlertAt: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: incidentPk(incidentId), sk: META_SK },
        UpdateExpression: 'SET #e = if_not_exists(#e, :zero) + :one, #l = :l',
        ExpressionAttributeNames: { '#e': 'echo_count', '#l': 'last_alert_at' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':l': lastAlertAt },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  async close(incidentId: string, reason: string, closedAt: string): Promise<Incident | undefined> {
    return this.update(incidentId, { status: 'closed', close_reason: reason, closed_at: closedAt });
  }

  async getLock(systemId: string): Promise<LockItem | undefined> {
    const res = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk: lockPk(systemId), sk: META_SK } }));
    if (!res.Item) return undefined;
    const item = res.Item as { incident_id: string; created_at: string; ttl: number };
    return { system_id: systemId, incident_id: item.incident_id, created_at: item.created_at, ttl: item.ttl };
  }

  /** Conditional lock creation. Returns false when the lock already exists. */
  async createLock(lock: LockItem): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: lockPk(lock.system_id), sk: META_SK, incident_id: lock.incident_id, created_at: lock.created_at, ttl: lock.ttl },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async deleteLock(systemId: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { pk: lockPk(systemId), sk: META_SK } }));
  }

  /** Newest first, via GSI by_status. */
  async listByStatus(status: IncidentStatus, options: IncidentListOptions = {}): Promise<Page<Incident>> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'by_status',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        ScanIndexForward: false,
        Limit: options.limit,
        ExclusiveStartKey: decodeCursor(options.cursor),
      }),
    );
    return { items: (res.Items ?? []).map((i) => stripKeys(i) as Incident), cursor: encodeCursor(res.LastEvaluatedKey) };
  }

  /** Newest first, via GSI by_system (optionally filtered by status). */
  async listBySystem(systemId: string, options: IncidentListOptions = {}): Promise<Page<Incident>> {
    const input: QueryCommandInput = {
      TableName: this.table,
      IndexName: 'by_system',
      KeyConditionExpression: 'system_id = :s',
      ExpressionAttributeValues: { ':s': systemId },
      ScanIndexForward: false,
      Limit: options.limit,
      ExclusiveStartKey: decodeCursor(options.cursor),
    };
    if (options.status) {
      input.FilterExpression = '#st = :st';
      input.ExpressionAttributeNames = { '#st': 'status' };
      input.ExpressionAttributeValues = { ...input.ExpressionAttributeValues, ':st': options.status };
    }
    const res = await this.client.send(new QueryCommand(input));
    return { items: (res.Items ?? []).map((i) => stripKeys(i) as Incident), cursor: encodeCursor(res.LastEvaluatedKey) };
  }

  /** All incidents with a given status (paginates internally). */
  async listAllByStatus(status: IncidentStatus): Promise<Incident[]> {
    const items = await queryAll<Record<string, unknown>>(this.client, {
      TableName: this.table,
      IndexName: 'by_status',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    });
    return items.map((i) => stripKeys(i) as Incident);
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export class AuditRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  async put(event: AuditEvent): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: event }));
  }

  async listByIncident(incidentId: string, options: { limit?: number; ascending?: boolean; cursor?: string } = {}): Promise<Page<AuditEvent>> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'incident_id = :i',
        ExpressionAttributeValues: { ':i': incidentId },
        ScanIndexForward: options.ascending ?? false,
        Limit: options.limit,
        ExclusiveStartKey: decodeCursor(options.cursor),
      }),
    );
    return { items: (res.Items ?? []) as AuditEvent[], cursor: encodeCursor(res.LastEvaluatedKey) };
  }
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface Repositories {
  roster: RosterRepository;
  availability: AvailabilityRepository;
  severity: SeverityRepository;
  incidents: IncidentsRepository;
  audit: AuditRepository;
}

export function createRepositories(client: DynamoDBDocumentClient = getDocClient()): Repositories {
  const env = commonEnv();
  return {
    roster: new RosterRepository(client, env.rosterTable),
    availability: new AvailabilityRepository(client, env.availabilityTable),
    severity: new SeverityRepository(client, env.severityTable),
    incidents: new IncidentsRepository(client, env.incidentsTable),
    audit: new AuditRepository(client, env.auditTable),
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function queryAll<T>(client: DynamoDBDocumentClient, input: QueryCommandInput): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((res.Items ?? []) as T[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function scanAll<T>(client: DynamoDBDocumentClient, input: { TableName: string }): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await client.send(new ScanCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((res.Items ?? []) as T[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}
