/**
 * Regression test for the webhook -> dispatchReply ctx payload.
 *
 * CommandAuthorized must be set explicitly: OpenClaw core's finalizeInboundContext
 * default-denies ("CommandAuthorized = normalized.CommandAuthorized === true") when a
 * channel forgets to populate it, which silently no-ops every slash command
 * (/verbose, /reasoning, /status, ...) with no reply and no error. Every reference
 * channel (Zalo, Google Chat, Nextcloud Talk, BlueBubbles) sets this field explicitly;
 * this plugin previously did not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createWebhookHandler,
  registerWebexWebhookTarget,
  setPluginRuntime,
} from './channel-plugin';
import type { OpenClawEnvelope } from './types';

function createMockReq(body: unknown): any {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = '/webhooks/webex/default';
  req.headers = {};
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createMockRes(): any {
  return {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

describe('webhook ctx payload', () => {
  let dispatchReply: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchReply = vi.fn().mockResolvedValue(undefined);
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: { reply: { dispatchReplyWithBufferedBlockDispatcher: dispatchReply } },
    } as any);

    const envelope: OpenClawEnvelope = {
      id: 'msg-1',
      channel: 'webex',
      conversationId: 'room-1',
      author: { id: 'person-1', email: 'user@example.com', isBot: false },
      content: { text: '/verbose off' },
      metadata: { roomType: 'direct', roomId: 'room-1', timestamp: '2026-07-16T00:00:00Z' },
    };

    registerWebexTargetForTest({
      account: { accountId: 'default', enabled: true, configured: true, config: {} as any },
      config: {} as any,
      webhookHandler: { handleWebhook: vi.fn().mockResolvedValue(envelope) } as any,
    });
  });

  function registerWebexTargetForTest(target: Parameters<typeof registerWebexWebhookTarget>[1]) {
    registerWebexWebhookTarget('/webhooks/webex/default', target);
  }

  it('sets CommandAuthorized: true so slash commands are not default-denied by core', async () => {
    const handler = createWebhookHandler();
    const req = createMockReq({
      resource: 'messages',
      event: 'created',
      data: { id: 'msg-1', roomId: 'room-1', personId: 'person-1', roomType: 'direct' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const call = dispatchReply.mock.calls[0][0];
    expect(call.ctx.CommandAuthorized).toBe(true);
  });
});
