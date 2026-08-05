/**
 * Regression test for the webhook -> dispatchReply ctx payload.
 *
 * CommandAuthorized must be set explicitly: OpenClaw core's finalizeInboundContext
 * default-denies ("CommandAuthorized = normalized.CommandAuthorized === true") when a
 * channel forgets to populate it, which silently no-ops every slash command
 * (/verbose, /reasoning, /status, ...) with no reply and no error. Every reference
 * channel (Zalo, Google Chat, Nextcloud Talk, BlueBubbles) sets this field explicitly;
 * this plugin previously did not.
 *
 * Also covers the "seen indicator" placeholder-and-edit reply flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock WebexSender so the reply path can be asserted without real HTTP. The
// mocks are shared across every constructed sender instance.
const { sendMock, editMessageMock, deleteMessageMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  editMessageMock: vi.fn(),
  deleteMessageMock: vi.fn(),
}));

vi.mock('./send', () => ({
  WebexSender: class {
    send = sendMock;
    editMessage = editMessageMock;
    deleteMessage = deleteMessageMock;
  },
}));

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
    sendMock.mockReset().mockResolvedValue({ id: 'placeholder-1', roomId: 'room-1' });
    editMessageMock.mockReset().mockResolvedValue({ id: 'placeholder-1', roomId: 'room-1' });
    deleteMessageMock.mockReset().mockResolvedValue(undefined);
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

describe('seen indicator (placeholder-and-edit)', () => {
  const envelope: OpenClawEnvelope = {
    id: 'msg-1',
    channel: 'webex',
    conversationId: 'room-1',
    author: { id: 'person-1', email: 'user@example.com', isBot: false },
    content: { text: 'hello there' },
    metadata: { roomType: 'direct', roomId: 'room-1', timestamp: '2026-07-16T00:00:00Z' },
  };

  function registerTarget(config: Record<string, unknown> = {}) {
    registerWebexWebhookTarget('/webhooks/webex/default', {
      account: { accountId: 'default', enabled: true, configured: true, config } as any,
      config: config as any,
      webhookHandler: { handleWebhook: vi.fn().mockResolvedValue(envelope) } as any,
    });
  }

  async function runInbound() {
    const handler = createWebhookHandler();
    const req = createMockReq({
      resource: 'messages',
      event: 'created',
      data: { id: 'msg-1', roomId: 'room-1', personId: 'person-1', roomType: 'direct' },
    });
    await handler(req, createMockRes());
  }

  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ id: 'placeholder-1', roomId: 'room-1' });
    editMessageMock.mockReset().mockResolvedValue({ id: 'placeholder-1', roomId: 'room-1' });
    deleteMessageMock.mockReset().mockResolvedValue(undefined);
  });

  it('posts a seen placeholder then edits it in place with the reply', async () => {
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
            await opts.dispatcherOptions.deliver({ text: 'the reply' });
          },
        },
      },
    } as any);
    registerTarget();

    await runInbound();

    // Placeholder posted first, as markdown, to the room.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'room-1',
        content: expect.objectContaining({ markdown: expect.stringContaining('Seen') }),
      })
    );
    // Reply edits the placeholder in place rather than posting a new message.
    expect(editMessageMock).toHaveBeenCalledWith('placeholder-1', 'room-1', { text: 'the reply' });
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('sends additional reply blocks as new messages after editing the placeholder', async () => {
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
            await opts.dispatcherOptions.deliver({ text: 'block 1' });
            await opts.dispatcherOptions.deliver({ text: 'block 2' });
          },
        },
      },
    } as any);
    registerTarget();

    await runInbound();

    expect(editMessageMock).toHaveBeenCalledTimes(1);
    expect(editMessageMock).toHaveBeenCalledWith('placeholder-1', 'room-1', { text: 'block 1' });
    // send: once for the placeholder, once for the second block.
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ text: 'block 2' }) })
    );
  });

  it('deletes the placeholder when the reply delivers nothing', async () => {
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            // no deliver() calls
          },
        },
      },
    } as any);
    registerTarget();

    await runInbound();

    expect(editMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).toHaveBeenCalledWith('placeholder-1');
  });

  it('does not post a placeholder when seenIndicator is false', async () => {
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
            await opts.dispatcherOptions.deliver({ text: 'the reply' });
          },
        },
      },
    } as any);
    registerTarget({ seenIndicator: false });

    await runInbound();

    expect(editMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
    // Only the reply is sent, as a plain message.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ text: 'the reply' }) })
    );
  });

  it('falls back to a normal send when editing the placeholder fails', async () => {
    editMessageMock.mockReset().mockRejectedValue(new Error('edit cap reached'));
    setPluginRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
            await opts.dispatcherOptions.deliver({ text: 'the reply' });
          },
        },
      },
    } as any);
    registerTarget();

    await runInbound();

    expect(editMessageMock).toHaveBeenCalledTimes(1);
    // Placeholder send + fallback reply send.
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ text: 'the reply' }) })
    );
  });
});
