import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function parseNote(body: string | null): { title: string; content: string } | null {
  if (!body) return null;
  try {
    const input: unknown = JSON.parse(body);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const note = input as Record<string, unknown>;
    if (typeof note.title !== 'string' || typeof note.content !== 'string') return null;
    const title = note.title.trim();
    if (title.length < 1 || title.length > 120 || note.content.length > 10000) return null;
    return { title, content: note.content };
  } catch {
    return null;
  }
}

function publicNote(item: Record<string, unknown>) {
  return {
    id: item.id,
    title: item.title,
    content: item.content,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const sub = event.requestContext.authorizer?.claims?.sub;
  const table = process.env.TABLE_NAME;
  if (typeof sub !== 'string' || !sub) return response(401, { error: 'Unauthorized' });
  if (!table) return response(500, { error: 'Internal error' });
  const pk = `USER#${sub}`;
  const id = event.pathParameters?.id;
  const method = event.httpMethod;
  if (id !== undefined && !uuidPattern.test(id)) return response(400, { error: 'Invalid note id' });

  try {
    if (!id && method === 'POST') {
      const note = parseNote(event.body);
      if (!note) return response(400, { error: 'Expected a title (1-120 chars) and content (max 10000 chars)' });
      const newId = randomUUID();
      const now = new Date().toISOString();
      const item = { pk, sk: `NOTE#${newId}`, id: newId, ...note, createdAt: now, updatedAt: now };
      await db.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      return response(201, publicNote(item));
    }

    if (!id && method === 'GET') {
      const token = event.queryStringParameters?.nextToken;
      let startKey: { pk: string; sk: string } | undefined;
      if (token !== undefined && token !== null) {
        if (token.length > 80) return response(400, { error: 'Invalid nextToken' });
        try {
          const sk = Buffer.from(token, 'base64url').toString('utf8');
          if (!sk.startsWith('NOTE#') || !uuidPattern.test(sk.slice(5)) || Buffer.from(sk).toString('base64url') !== token) {
            return response(400, { error: 'Invalid nextToken' });
          }
          startKey = { pk, sk };
        } catch {
          return response(400, { error: 'Invalid nextToken' });
        }
      }
      const result = await db.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': 'NOTE#' },
        ExclusiveStartKey: startKey,
        Limit: 50,
      }));
      return response(200, {
        items: (result.Items ?? []).map(publicNote),
        ...(result.LastEvaluatedKey?.sk ? { nextToken: Buffer.from(String(result.LastEvaluatedKey.sk)).toString('base64url') } : {}),
      });
    }

    if (id && method === 'GET') {
      const result = await db.send(new GetCommand({ TableName: table, Key: { pk, sk: `NOTE#${id}` } }));
      return result.Item ? response(200, publicNote(result.Item)) : response(404, { error: 'Not found' });
    }

    if (id && method === 'PUT') {
      const note = parseNote(event.body);
      if (!note) return response(400, { error: 'Expected a title (1-120 chars) and content (max 10000 chars)' });
      const result = await db.send(new UpdateCommand({
        TableName: table,
        Key: { pk, sk: `NOTE#${id}` },
        UpdateExpression: 'SET title = :title, content = :content, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':title': note.title, ':content': note.content, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      return response(200, publicNote(result.Attributes ?? {}));
    }

    if (id && method === 'DELETE') {
      await db.send(new DeleteCommand({
        TableName: table,
        Key: { pk, sk: `NOTE#${id}` },
        ConditionExpression: 'attribute_exists(pk)',
      }));
      return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
    }
    return response(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return response(method === 'POST' ? 409 : 404, { error: method === 'POST' ? 'Conflict' : 'Not found' });
    }
    console.error('Notes request failed', error instanceof Error ? error.name : 'UnknownError');
    return response(500, { error: 'Internal error' });
  }
}
