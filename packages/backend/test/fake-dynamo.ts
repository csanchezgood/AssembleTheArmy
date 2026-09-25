// Minimal in-memory DynamoDB emulation for the operations the repositories use.
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DeleteCommandInput,
  type GetCommandInput,
  type PutCommandInput,
  type QueryCommandInput,
  type ScanCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

type Item = Record<string, unknown>;

export interface TableSchema {
  pk: string;
  sk?: string;
  indexes?: Record<string, { pk: string; sk: string }>;
}

export class FakeDynamo {
  readonly mock = mockClient(DynamoDBDocumentClient);
  private readonly tables = new Map<string, { schema: TableSchema; items: Map<string, Item> }>();

  constructor(schemas: Record<string, TableSchema>) {
    for (const [name, schema] of Object.entries(schemas)) this.tables.set(name, { schema, items: new Map() });
    this.mock.on(GetCommand).callsFake((input: GetCommandInput) => this.get(input));
    this.mock.on(PutCommand).callsFake((input: PutCommandInput) => this.put(input));
    this.mock.on(UpdateCommand).callsFake((input: UpdateCommandInput) => this.update(input));
    this.mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => this.delete(input));
    this.mock.on(QueryCommand).callsFake((input: QueryCommandInput) => this.query(input));
    this.mock.on(ScanCommand).callsFake((input: ScanCommandInput) => this.scan(input));
  }

  restore(): void {
    this.mock.restore();
  }

  seed(table: string, items: readonly object[]): void {
    for (const item of items) this.put({ TableName: table, Item: item as Item });
  }

  items(table: string): Item[] {
    return [...this.table(table).items.values()].map((i) => structuredClone(i));
  }

  private table(name: string | undefined) {
    const t = name ? this.tables.get(name) : undefined;
    if (!t) throw new Error(`FakeDynamo: tabla desconocida ${name}`);
    return t;
  }

  private keyOf(schema: TableSchema, item: Item): string {
    const pk = String(item[schema.pk]);
    return schema.sk ? `${pk}\u0000${String(item[schema.sk])}` : pk;
  }

  private get(input: GetCommandInput) {
    const t = this.table(input.TableName);
    const item = t.items.get(this.keyOf(t.schema, input.Key ?? {}));
    return { Item: item ? structuredClone(item) : undefined };
  }

  private put(input: PutCommandInput) {
    const t = this.table(input.TableName);
    const item = input.Item ?? {};
    const key = this.keyOf(t.schema, item);
    if (input.ConditionExpression?.includes('attribute_not_exists') && t.items.has(key)) throw conditionalFailure();
    t.items.set(key, structuredClone(item));
    return {};
  }

  private delete(input: DeleteCommandInput) {
    const t = this.table(input.TableName);
    t.items.delete(this.keyOf(t.schema, input.Key ?? {}));
    return {};
  }

  private update(input: UpdateCommandInput) {
    const t = this.table(input.TableName);
    const key = this.keyOf(t.schema, input.Key ?? {});
    const existing = t.items.get(key);
    if (input.ConditionExpression?.includes('attribute_exists') && !existing) throw conditionalFailure();
    const item: Item = existing ? structuredClone(existing) : { ...(input.Key ?? {}) };
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const resolveName = (n: string) => (n.startsWith('#') ? names[n] ?? n : n);
    const expr = input.UpdateExpression ?? '';
    const setMatch = /SET\s+(.+?)(?:\s+REMOVE\s+(.+))?$/s.exec(expr);
    const removeOnly = /^REMOVE\s+(.+)$/s.exec(expr);
    if (setMatch) {
      for (const clause of splitClauses(setMatch[1] ?? '')) {
        const [lhs, rhs] = clause.split('=').map((s) => s.trim()) as [string, string];
        const field = resolveName(lhs);
        const inc = /if_not_exists\((#?\w+),\s*(:\w+)\)\s*\+\s*(:\w+)/.exec(rhs);
        if (inc) {
          const current = item[resolveName(inc[1] ?? '')];
          const base = typeof current === 'number' ? current : (values[inc[2] ?? ''] as number);
          item[field] = base + (values[inc[3] ?? ''] as number);
        } else {
          item[field] = structuredClone(values[rhs]);
        }
      }
      for (const n of (setMatch[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) delete item[resolveName(n)];
    } else if (removeOnly) {
      for (const n of (removeOnly[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) delete item[resolveName(n)];
    }
    t.items.set(key, item);
    return { Attributes: structuredClone(item) };
  }

  private query(input: QueryCommandInput) {
    const t = this.table(input.TableName);
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const resolveName = (n: string) => (n.startsWith('#') ? names[n] ?? n : n);
    const cond = input.KeyConditionExpression ?? '';
    const eq = /(#?\w+)\s*=\s*(:\w+)/.exec(cond);
    const bw = /begins_with\((#?\w+),\s*(:\w+)\)/.exec(cond);
    let items = [...t.items.values()];
    if (eq) items = items.filter((i) => i[resolveName(eq[1] ?? '')] === values[eq[2] ?? '']);
    if (bw) items = items.filter((i) => String(i[resolveName(bw[1] ?? '')] ?? '').startsWith(String(values[bw[2] ?? ''])));
    const filter = input.FilterExpression ? /(#?\w+)\s*=\s*(:\w+)/.exec(input.FilterExpression) : null;
    if (filter) items = items.filter((i) => i[resolveName(filter[1] ?? '')] === values[filter[2] ?? '']);
    const index = input.IndexName ? t.schema.indexes?.[input.IndexName] : undefined;
    if (index) items = items.filter((i) => i[index.pk] !== undefined && i[index.sk] !== undefined);
    const sortKey = index?.sk ?? t.schema.sk;
    if (sortKey) {
      items.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])));
      if (input.ScanIndexForward === false) items.reverse();
    }
    if (input.Limit) items = items.slice(0, input.Limit);
    return { Items: items.map((i) => structuredClone(i)) };
  }

  private scan(input: ScanCommandInput) {
    const t = this.table(input.TableName);
    return { Items: [...t.items.values()].map((i) => structuredClone(i)) };
  }
}

function splitClauses(text: string): string[] {
  // Split on commas that are not inside parentheses.
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function conditionalFailure(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}
