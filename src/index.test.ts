/**
 * Tests for index exports
 */

import { describe, it, expect, vi } from 'vitest';
import * as exports from './index';
import defaultExport, {
  id,
  WebexChannel,
  createWebexChannel,
  createAndInitialize,
  WebexSender,
  WebexApiRequestError,
  WebexWebhookHandler,
  WebhookValidationError,
  webexPlugin,
} from './index';

// Mock node-fetch for the outbound-adapter behavioral tests below
vi.mock('node-fetch', () => ({
  default: vi.fn(),
  Response: vi.fn(),
}));

import fetch from 'node-fetch';
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

function createMockResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(data),
  };
}

describe('index exports', () => {
  describe('named exports', () => {
    it('should export WebexChannel class', () => {
      expect(WebexChannel).toBeDefined();
      expect(typeof WebexChannel).toBe('function');
    });

    it('should export createWebexChannel function', () => {
      expect(createWebexChannel).toBeDefined();
      expect(typeof createWebexChannel).toBe('function');
    });

    it('should export createAndInitialize function', () => {
      expect(createAndInitialize).toBeDefined();
      expect(typeof createAndInitialize).toBe('function');
    });

    it('should export WebexSender class', () => {
      expect(WebexSender).toBeDefined();
      expect(typeof WebexSender).toBe('function');
    });

    it('should export WebexApiRequestError class', () => {
      expect(WebexApiRequestError).toBeDefined();
      expect(typeof WebexApiRequestError).toBe('function');
    });

    it('should export WebexWebhookHandler class', () => {
      expect(WebexWebhookHandler).toBeDefined();
      expect(typeof WebexWebhookHandler).toBe('function');
    });

    it('should export WebhookValidationError class', () => {
      expect(WebhookValidationError).toBeDefined();
      expect(typeof WebhookValidationError).toBe('function');
    });

    it('should export plugin id', () => {
      expect(id).toBe('webex');
    });

    it('should export webexPlugin channel plugin', () => {
      expect(webexPlugin).toBeDefined();
      expect(typeof webexPlugin).toBe('object');
    });
  });

  describe('default export (plugin registration function)', () => {
    it('should export plugin registration function as default', () => {
      expect(defaultExport).toBeDefined();
      expect(typeof defaultExport).toBe('function');
    });

    it('should be callable with an api object', () => {
      // Create a mock api object
      const mockApi = {
        registerChannel: vi.fn(),
        registerHttpRoute: vi.fn(),
        runtime: {},
      };

      // Call the plugin registration function
      defaultExport(mockApi as any);

      // Verify registerChannel was called with the webexPlugin
      expect(mockApi.registerChannel).toHaveBeenCalledTimes(1);
      expect(mockApi.registerChannel).toHaveBeenCalledWith({ plugin: webexPlugin });
      // Verify registerHttpRoute was called
      expect(mockApi.registerHttpRoute).toHaveBeenCalledTimes(1);
      expect(mockApi.registerHttpRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/webhooks/webex',
          match: 'prefix',
          auth: 'plugin',
          handler: expect.any(Function),
        })
      );
    });
  });

  describe('webexPlugin channel plugin', () => {
    it('should have correct id', () => {
      expect(webexPlugin.id).toBe('webex');
    });

    it('should have meta with correct label', () => {
      expect(webexPlugin.meta.label).toBe('Webex');
    });

    it('should have meta with correct selectionLabel', () => {
      expect(webexPlugin.meta.selectionLabel).toBe('Cisco Webex');
    });

    it('should have meta with docsPath', () => {
      expect(webexPlugin.meta.docsPath).toBe('/channels/webex');
    });

    it('should have meta with blurb', () => {
      expect(webexPlugin.meta.blurb).toBe('Cisco Webex messaging via bot webhooks.');
    });

    it('should have meta with aliases', () => {
      expect(webexPlugin.meta.aliases).toContain('cisco-webex');
    });

    describe('capabilities', () => {
      it('should support direct chat type', () => {
        expect(webexPlugin.capabilities.chatTypes).toContain('direct');
      });

      it('should support group chat type', () => {
        expect(webexPlugin.capabilities.chatTypes).toContain('group');
      });

      it('should support threads', () => {
        expect(webexPlugin.capabilities.threads).toBe(true);
      });

      it('should support media', () => {
        expect(webexPlugin.capabilities.media).toBe(true);
      });
    });

    describe('config adapter', () => {
      it('should have listAccountIds function', () => {
        expect(typeof webexPlugin.config.listAccountIds).toBe('function');
      });

      it('should have resolveAccount function', () => {
        expect(typeof webexPlugin.config.resolveAccount).toBe('function');
      });

      it('should have defaultAccountId function', () => {
        expect(typeof webexPlugin.config.defaultAccountId).toBe('function');
      });
    });

    describe('messaging adapter', () => {
      describe('targetResolver.looksLikeId', () => {
        // The real host calls looksLikeId(raw, normalized), where `raw`
        // still carries the "webex:" prefix and `normalized` has it
        // stripped - looksLikeId must check `normalized`, not `raw`.
        it('should accept a base64 Webex ID via the normalized argument even when raw still has the webex: prefix', () => {
          const raw = 'webex:Y2lzY29zcGFyazovL3VzL1JPT00vYWJj';
          const normalized = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWJj';
          expect(webexPlugin.messaging!.targetResolver!.looksLikeId(raw, normalized)).toBe(true);
        });

        it('should accept an email via the normalized argument', () => {
          expect(
            webexPlugin.messaging!.targetResolver!.looksLikeId('webex:user@example.com', 'user@example.com')
          ).toBe(true);
        });

        it('should reject a normalized value that is neither a Webex ID nor an email', () => {
          expect(webexPlugin.messaging!.targetResolver!.looksLikeId('webex:nonsense', 'nonsense')).toBe(false);
        });
      });
    });

    describe('outbound adapter', () => {
      it('should have deliveryMode', () => {
        expect(webexPlugin.outbound.deliveryMode).toBe('direct');
      });

      it('should have textChunkLimit', () => {
        expect(webexPlugin.outbound.textChunkLimit).toBe(7000);
      });

      it('should have sendText function', () => {
        expect(typeof webexPlugin.outbound.sendText).toBe('function');
      });

      it('should have sendMedia function', () => {
        expect(typeof webexPlugin.outbound.sendMedia).toBe('function');
      });

      // The real host never passes a pre-resolved account into outbound
      // hooks - only cfg + accountId - so tests must mirror that shape to
      // catch a regression back to destructuring `account` directly.
      describe('account resolution from cfg + accountId', () => {
        const cfg = {
          channels: {
            webex: {
              token: 'test-token',
              webhookUrl: 'https://example.com/webhook',
              dmPolicy: 'allow' as const,
            },
          },
        };
        const accountId = 'default';

        it('sendText should resolve the account from cfg/accountId and send', async () => {
          mockFetch.mockResolvedValueOnce(
            createMockResponse({
              id: 'message-123',
              roomId: 'room-123',
              roomType: 'group',
              personId: 'person-123',
              personEmail: 'person@example.com',
              created: '2024-01-01T00:00:00.000Z',
            })
          );

          const result = await webexPlugin.outbound.sendText({
            cfg,
            to: 'room-123',
            text: 'hello from cron',
            accountId,
          });

          expect(result).toEqual({
            channel: 'webex',
            messageId: 'message-123',
            roomId: 'room-123',
          });
        });

        it('sendMedia should resolve the account from cfg/accountId and send', async () => {
          mockFetch.mockResolvedValueOnce(
            createMockResponse({
              id: 'message-456',
              roomId: 'room-123',
              roomType: 'group',
              personId: 'person-123',
              personEmail: 'person@example.com',
              created: '2024-01-01T00:00:00.000Z',
            })
          );

          const result = await webexPlugin.outbound.sendMedia!({
            cfg,
            to: 'room-123',
            text: 'hello with media',
            mediaUrl: 'https://example.com/file.png',
            accountId,
          });

          expect(result).toEqual({
            channel: 'webex',
            messageId: 'message-456',
            roomId: 'room-123',
          });
        });
      });
    });

    describe('gateway adapter', () => {
      it('should have startAccount function', () => {
        expect(typeof webexPlugin.gateway?.startAccount).toBe('function');
      });
    });
  });

  describe('type exports (compile-time check)', () => {
    // These tests verify that types are exported correctly at compile time
    // They don't test runtime behavior but ensure TypeScript compilation succeeds

    it('should be able to use WebexChannelConfig type', () => {
      const config: exports.WebexChannelConfig = {
        token: 'test',
        webhookUrl: 'https://example.com',
        dmPolicy: 'allow',
      };
      expect(config.token).toBe('test');
    });

    it('should be able to use DmPolicy type', () => {
      const policy: exports.DmPolicy = 'allow';
      expect(policy).toBe('allow');
    });

    it('should be able to use OpenClawEnvelope type', () => {
      const envelope: exports.OpenClawEnvelope = {
        id: 'test',
        channel: 'webex',
        conversationId: 'room-123',
        author: {
          id: 'person-123',
          isBot: false,
        },
        content: {
          text: 'Hello',
        },
        metadata: {
          roomType: 'group',
          roomId: 'room-123',
          timestamp: '2024-01-01T00:00:00.000Z',
          raw: {
            id: 'msg-123',
            roomId: 'room-123',
            roomType: 'group',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      expect(envelope.id).toBe('test');
    });

    it('should be able to use OpenClawOutboundMessage type', () => {
      const message: exports.OpenClawOutboundMessage = {
        to: 'room-123',
        content: {
          text: 'Hello',
        },
      };
      expect(message.to).toBe('room-123');
    });

    it('should be able to use WebexMessage type', () => {
      const message: exports.WebexMessage = {
        id: 'msg-123',
        roomId: 'room-123',
        roomType: 'group',
        personId: 'person-123',
        personEmail: 'person@example.com',
        created: '2024-01-01T00:00:00.000Z',
      };
      expect(message.id).toBe('msg-123');
    });

    it('should be able to use WebexWebhookPayload type', () => {
      const payload: exports.WebexWebhookPayload = {
        id: 'webhook-123',
        name: 'Test',
        targetUrl: 'https://example.com',
        resource: 'messages',
        event: 'created',
        orgId: 'org-123',
        createdBy: 'user-123',
        appId: 'app-123',
        ownedBy: 'creator',
        status: 'active',
        created: '2024-01-01T00:00:00.000Z',
        actorId: 'actor-123',
        data: {
          id: 'msg-123',
          roomId: 'room-123',
          roomType: 'group',
          personId: 'person-123',
          personEmail: 'person@example.com',
          created: '2024-01-01T00:00:00.000Z',
        },
      };
      expect(payload.id).toBe('webhook-123');
    });

    it('should be able to use WebhookHandler type', () => {
      const handler: exports.WebhookHandler = (envelope) => {
        console.log(envelope.id);
      };
      expect(typeof handler).toBe('function');
    });

    it('should be able to use CreateMessageRequest type', () => {
      const request: exports.CreateMessageRequest = {
        roomId: 'room-123',
        text: 'Hello',
      };
      expect(request.roomId).toBe('room-123');
    });

    it('should be able to use RetryOptions type', () => {
      const options: exports.RetryOptions = {
        maxRetries: 3,
        retryDelayMs: 1000,
      };
      expect(options.maxRetries).toBe(3);
    });

    it('should be able to use RequestOptions type', () => {
      const options: exports.RequestOptions = {
        method: 'GET',
        path: '/messages',
      };
      expect(options.method).toBe('GET');
    });
  });

  describe('error classes work correctly', () => {
    it('should instantiate WebexApiRequestError', () => {
      const error = new WebexApiRequestError('Test error', 400);
      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(400);
      expect(error).toBeInstanceOf(Error);
    });

    it('should instantiate WebhookValidationError', () => {
      const error = new WebhookValidationError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('WebhookValidationError');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('classes are constructible', () => {
    it('should construct WebexChannel', () => {
      const channel = new WebexChannel();
      expect(channel.name).toBe('webex');
      expect(channel.version).toBe('1.0.0');
    });

    it('should construct WebexSender', () => {
      const sender = new WebexSender({
        token: 'test',
        webhookUrl: 'https://example.com',
        dmPolicy: 'allow',
      });
      expect(sender).toBeInstanceOf(WebexSender);
    });

    it('should construct WebexWebhookHandler', () => {
      const handler = new WebexWebhookHandler({
        token: 'test',
        webhookUrl: 'https://example.com',
        dmPolicy: 'allow',
      });
      expect(handler).toBeInstanceOf(WebexWebhookHandler);
    });
  });
});
