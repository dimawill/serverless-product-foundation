import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { handler } from '../lambda/notes';

const db = mockClient(DynamoDBDocumentClient);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function event(method: string, noteId?: string, body: string | null = null, sub = 'user-one', nextToken?: string): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    pathParameters: noteId ? { id: noteId } : null,
    queryStringParameters: nextToken !== undefined ? { nextToken } : null,
    body,
    requestContext: { authorizer: { claims: { sub } } },
  } as unknown as APIGatewayProxyEvent;
}
const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

beforeEach(() => {
  process.env.TABLE_NAME = 'test-notes';
  db.reset();
});
afterAll(() => db.restore());

describe('notes handler', () => {
  it('creates a note with a per-user key and no exposed internal keys', async () => {
    db.on(PutCommand).resolves({});
    const result = await handler(event('POST', undefined, JSON.stringify({ title: ' Hello ', content: 'world' })));
    expect(result.statusCode).toBe(201);
    expect(parse(result.body)).toMatchObject({ title: 'Hello', content: 'world' });
    expect(parse(result.body)).not.toHaveProperty('pk');
    const stored = db.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(stored?.pk).toBe('USER#user-one');
    expect(stored?.sk).toBe(`NOTE#${parse(result.body).id}`);
    expect(db.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('lists only the authenticated partition, with pagination', async () => {
    db.on(QueryCommand).resolves({
      Items: [{ pk: 'USER#user-two', sk: `NOTE#${id}`, id, title: 'T', content: 'C' }],
      LastEvaluatedKey: { pk: 'USER#user-one', sk: `NOTE#${id}` },
    });
    const result = await handler(event('GET'));
    expect(result.statusCode).toBe(200);
    expect(parse(result.body).items).toEqual([{ id, title: 'T', content: 'C' }]);
    const token = parse(result.body).nextToken as string;
    await handler(event('GET', undefined, null, 'user-two', token));
    const query = db.commandCalls(QueryCommand)[1].args[0].input;
    expect(query.ExpressionAttributeValues?.[':pk']).toBe('USER#user-two');
    expect(query.ExclusiveStartKey).toEqual({ pk: 'USER#user-two', sk: `NOTE#${id}` });
  });

  it('reads within only the caller partition; missing item returns 404', async () => {
    db.on(GetCommand).resolves({});
    expect((await handler(event('GET', id, null, 'user-two'))).statusCode).toBe(404);
    expect(db.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ pk: 'USER#user-two', sk: `NOTE#${id}` });
    db.reset();
    db.on(GetCommand).resolves({ Item: { id, pk: 'USER#user-one', sk: `NOTE#${id}`, title: 'A', content: 'B' } });
    const result = await handler(event('GET', id));
    expect(parse(result.body)).not.toHaveProperty('pk');
  });

  it('updates only existing notes with a conditional write', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { id, title: 'Updated', content: 'body' } });
    const result = await handler(event('PUT', id, JSON.stringify({ title: 'Updated', content: 'body' })));
    expect(result.statusCode).toBe(200);
    const input = db.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: 'USER#user-one', sk: `NOTE#${id}` });
    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('deletes an existing note, and missing notes return 404', async () => {
    db.on(DeleteCommand).resolves({});
    const result = await handler(event('DELETE', id));
    expect(result).toMatchObject({ statusCode: 204, body: '' });
    expect(db.commandCalls(DeleteCommand)[0].args[0].input.ConditionExpression).toBe('attribute_exists(pk)');
    db.reset();
    db.on(DeleteCommand).rejects(Object.assign(new Error('not found'), { name: 'ConditionalCheckFailedException' }));
    expect((await handler(event('DELETE', id))).statusCode).toBe(404);
  });

  it('rejects unauthenticated, malformed, oversized and invalid-ID requests without touching DynamoDB', async () => {
    const noClaims = event('GET');
    noClaims.requestContext.authorizer = undefined;
    expect((await handler(noClaims)).statusCode).toBe(401);
    expect((await handler(event('POST', undefined, '{invalid'))).statusCode).toBe(400);
    expect((await handler(event('POST', undefined, JSON.stringify({ title: 'x', content: 'a'.repeat(10001) })))).statusCode).toBe(400);
    expect((await handler(event('GET', 'invalid'))).statusCode).toBe(400);
    expect((await handler(event('GET', undefined, null, 'user-one', '@bad'))).statusCode).toBe(400);
    expect((await handler(event('GET', undefined, null, 'user-one', ''))).statusCode).toBe(400);
    expect(db.calls()).toHaveLength(0);
  });

  it('fails closed when TABLE_NAME is missing', async () => {
    delete process.env.TABLE_NAME;
    expect((await handler(event('GET'))).statusCode).toBe(500);
    expect(db.calls()).toHaveLength(0);
  });

  it('keeps internal errors private', async () => {
    db.on(GetCommand).rejects(new Error('sensitive details'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await handler(event('GET', id));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('sensitive details');
    log.mockRestore();
  });
});
