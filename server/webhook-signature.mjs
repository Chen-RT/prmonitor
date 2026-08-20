import { createHmac, timingSafeEqual } from 'node:crypto';

export class WebhookHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'WebhookHttpError';
    this.statusCode = statusCode;
  }
}

export async function readRawBody(request, maxBytes = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new WebhookHttpError(413, 'Webhook 请求体超过配置上限。');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export function parseJsonBuffer(rawBody) {
  if (!rawBody?.length) return {};
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookHttpError(400, 'Webhook 请求体不是有效 JSON。');
  }
}

export function verifyBitbucketWebhookSignature(rawBody, signatureHeader, secret) {
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const match = String(header || '').trim().match(/^sha256=([a-f0-9]{64})$/i);
  if (!match || !secret) return false;
  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}
