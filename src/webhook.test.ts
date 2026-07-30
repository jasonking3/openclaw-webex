/**
 * Tests for WebexWebhookHandler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebexWebhookHandler, WebhookValidationError } from './webhook';
import type {
  WebexChannelConfig,
  WebexWebhookPayload,
  WebexMessage,
  WebexWebhook,
  PaginatedResponse,
} from './types';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetch from 'node-fetch';
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

// Helper to create mock Response
function createMockResponse(data: unknown, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

describe('WebexWebhookHandler', () => {
  let config: WebexChannelConfig;
  let handler: WebexWebhookHandler;

  const mockBotInfo = {
    id: 'bot-123',
    displayName: 'Test Bot',
    emails: ['bot@example.com'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      token: 'test-token',
      webhookUrl: 'https://example.com/webhook',
      dmPolicy: 'allow',
    };
    handler = new WebexWebhookHandler(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(handler).toBeInstanceOf(WebexWebhookHandler);
    });

    it('should use default API base URL when not provided', () => {
      const h = new WebexWebhookHandler(config);
      expect(h.getBotId()).toBeNull();
    });

    it('should use custom API base URL when provided', () => {
      const customConfig = { ...config, apiBaseUrl: 'https://custom.api.com/v1' };
      const h = new WebexWebhookHandler(customConfig);
      expect(h).toBeInstanceOf(WebexWebhookHandler);
    });
  });

  describe('initialize', () => {
    it('should fetch bot info on initialization', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));

      await handler.initialize();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://webexapis.com/v1/people/me',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
      expect(handler.getBotId()).toBe('bot-123');
    });

    it('should throw error when bot info request fails', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, false, 401, 'Unauthorized'));

      await expect(handler.initialize()).rejects.toThrow('Failed to get bot info: 401 Unauthorized');
    });
  });

  describe('handleWebhook', () => {
    const createPayload = (overrides?: Partial<WebexWebhookPayload>): WebexWebhookPayload => ({
      id: 'webhook-id',
      name: 'Test Webhook',
      targetUrl: 'https://example.com/webhook',
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
        id: 'message-123',
        roomId: 'room-123',
        roomType: 'group',
        personId: 'person-123',
        personEmail: 'person@example.com',
        created: '2024-01-01T00:00:00.000Z',
      },
      ...overrides,
    });

    const mockMessage: WebexMessage = {
      id: 'message-123',
      roomId: 'room-123',
      roomType: 'group',
      text: 'Hello, world!',
      markdown: '**Hello**, world!',
      personId: 'person-123',
      personEmail: 'person@example.com',
      created: '2024-01-01T00:00:00.000Z',
    };

    beforeEach(async () => {
      // Initialize handler with bot info
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await handler.initialize();
      mockFetch.mockClear();
    });

    it('should return envelope for valid message webhook', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const payload = createPayload();
      const envelope = await handler.handleWebhook(payload);

      expect(envelope).not.toBeNull();
      expect(envelope?.id).toBe('message-123');
      expect(envelope?.channel).toBe('webex');
      expect(envelope?.conversationId).toBe('room-123');
      expect(envelope?.content.text).toBe('Hello, world!');
      expect(envelope?.author.id).toBe('person-123');
    });

    it('should return null for non-message resource', async () => {
      const payload = createPayload({ resource: 'memberships' });
      const envelope = await handler.handleWebhook(payload);

      expect(envelope).toBeNull();
    });

    it('should return null for non-created event', async () => {
      const payload = createPayload({ event: 'deleted' });
      const envelope = await handler.handleWebhook(payload);

      expect(envelope).toBeNull();
    });

    it('should return null for messages from bot itself', async () => {
      const payload = createPayload({
        data: {
          id: 'message-123',
          roomId: 'room-123',
          roomType: 'group',
          personId: 'bot-123', // Bot's own ID
          personEmail: 'bot@example.com',
          created: '2024-01-01T00:00:00.000Z',
        },
      });

      const envelope = await handler.handleWebhook(payload);
      expect(envelope).toBeNull();
    });

    it('should verify signature when secret is configured', async () => {
      const secretConfig = { ...config, webhookSecret: 'test-secret' };
      const secretHandler = new WebexWebhookHandler(secretConfig);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await secretHandler.initialize();
      mockFetch.mockClear();

      const payload = createPayload();
      const crypto = await import('crypto');
      const hmac = crypto.createHmac('sha1', 'test-secret');
      hmac.update(JSON.stringify(payload));
      const validSignature = hmac.digest('hex');

      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const envelope = await secretHandler.handleWebhook(payload, validSignature);
      expect(envelope).not.toBeNull();
    });

    it('should throw WebhookValidationError for invalid signature', async () => {
      const secretConfig = { ...config, webhookSecret: 'test-secret' };
      const secretHandler = new WebexWebhookHandler(secretConfig);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await secretHandler.initialize();

      const payload = createPayload();
      // Use a signature with the same length as a valid SHA1 hex digest (40 chars)
      // but with incorrect content
      const invalidSignature = '0000000000000000000000000000000000000000';

      await expect(
        secretHandler.handleWebhook(payload, invalidSignature)
      ).rejects.toThrow(WebhookValidationError);
    });

    it('should handle signature with mismatched length gracefully', async () => {
      const secretConfig = { ...config, webhookSecret: 'test-secret' };
      const secretHandler = new WebexWebhookHandler(secretConfig);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await secretHandler.initialize();

      const payload = createPayload();
      // timingSafeEqual throws RangeError when lengths don't match
      // This tests that the error propagates (current behavior)
      await expect(
        secretHandler.handleWebhook(payload, 'short')
      ).rejects.toThrow();
    });

    it('should throw error when message fetch fails', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, false, 404, 'Not Found'));

      const payload = createPayload();
      await expect(handler.handleWebhook(payload)).rejects.toThrow('Failed to fetch message');
    });

    describe('DM Policy', () => {
      it('should allow direct messages when dmPolicy is allow', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({ ...mockMessage, roomType: 'direct' }));

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await handler.handleWebhook(payload);
        expect(envelope).not.toBeNull();
      });

      it('should deny direct messages when dmPolicy is deny', async () => {
        const denyConfig = { ...config, dmPolicy: 'deny' as const };
        const denyHandler = new WebexWebhookHandler(denyConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await denyHandler.initialize();

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await denyHandler.handleWebhook(payload);
        expect(envelope).toBeNull();
      });

      it('should allow allowlisted person by ID', async () => {
        const allowConfig = {
          ...config,
          dmPolicy: 'allowlisted' as const,
          allowFrom: ['person-123'],
        };
        const allowHandler = new WebexWebhookHandler(allowConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();
        mockFetch.mockClear();

        mockFetch.mockResolvedValueOnce(createMockResponse({ ...mockMessage, roomType: 'direct' }));

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await allowHandler.handleWebhook(payload);
        expect(envelope).not.toBeNull();
      });

      it('should allow allowlisted person by email', async () => {
        const allowConfig = {
          ...config,
          dmPolicy: 'allowlisted' as const,
          allowFrom: ['person@example.com'],
        };
        const allowHandler = new WebexWebhookHandler(allowConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();
        mockFetch.mockClear();

        mockFetch.mockResolvedValueOnce(createMockResponse({ ...mockMessage, roomType: 'direct' }));

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await allowHandler.handleWebhook(payload);
        expect(envelope).not.toBeNull();
      });

      it('should deny non-allowlisted person', async () => {
        const allowConfig = {
          ...config,
          dmPolicy: 'allowlisted' as const,
          allowFrom: ['other-person'],
        };
        const allowHandler = new WebexWebhookHandler(allowConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await allowHandler.handleWebhook(payload);
        expect(envelope).toBeNull();
      });

      it('should deny when allowlisted but allowFrom is empty', async () => {
        const allowConfig = {
          ...config,
          dmPolicy: 'allowlisted' as const,
          allowFrom: [],
        };
        const allowHandler = new WebexWebhookHandler(allowConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await allowHandler.handleWebhook(payload);
        expect(envelope).toBeNull();
      });

      it('should deny when allowlisted but allowFrom is undefined', async () => {
        const allowConfig = {
          ...config,
          dmPolicy: 'allowlisted' as const,
          // No allowFrom defined
        };
        const allowHandler = new WebexWebhookHandler(allowConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();

        const payload = createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        });

        const envelope = await allowHandler.handleWebhook(payload);
        expect(envelope).toBeNull();
      });

      it('should treat the canonical "allowlist" spelling like "allowlisted"', async () => {
        // 'allowlist' is OpenClaw's canonical spelling and a valid DmPolicy;
        // it must gate on allowFrom, not silently drop every DM.
        const allowHandler = new WebexWebhookHandler({
          ...config,
          dmPolicy: 'allowlist' as const,
          allowFrom: ['person-123'],
        });
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();
        mockFetch.mockClear();

        mockFetch.mockResolvedValueOnce(createMockResponse({ ...mockMessage, roomType: 'direct' }));

        const allowed = await allowHandler.handleWebhook(createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        }));
        expect(allowed).not.toBeNull();
      });

      it('should deny a non-allowlisted person under the "allowlist" spelling', async () => {
        const allowHandler = new WebexWebhookHandler({
          ...config,
          dmPolicy: 'allowlist' as const,
          allowFrom: ['other-person'],
        });
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await allowHandler.initialize();

        const envelope = await allowHandler.handleWebhook(createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        }));
        expect(envelope).toBeNull();
      });

      it('should allow a pre-approved sender under the "pairing" policy', async () => {
        // 'pairing' has no webhook-layer handshake, so it gates on allowFrom
        // like the allowlist policies rather than hitting the silent default.
        const pairingHandler = new WebexWebhookHandler({
          ...config,
          dmPolicy: 'pairing' as const,
          allowFrom: ['person-123'],
        });
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await pairingHandler.initialize();
        mockFetch.mockClear();

        mockFetch.mockResolvedValueOnce(createMockResponse({ ...mockMessage, roomType: 'direct' }));

        const allowed = await pairingHandler.handleWebhook(createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        }));
        expect(allowed).not.toBeNull();
      });

      it('should deny an unknown sender under the "pairing" policy', async () => {
        const pairingHandler = new WebexWebhookHandler({
          ...config,
          dmPolicy: 'pairing' as const,
          allowFrom: ['other-person'],
        });
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await pairingHandler.initialize();

        const envelope = await pairingHandler.handleWebhook(createPayload({
          data: {
            id: 'message-123',
            roomId: 'room-123',
            roomType: 'direct',
            personId: 'person-123',
            personEmail: 'person@example.com',
            created: '2024-01-01T00:00:00.000Z',
          },
        }));
        expect(envelope).toBeNull();
      });
    });

    describe('normalizeMessage', () => {
      it('should include file attachments', async () => {
        const messageWithFiles: WebexMessage = {
          ...mockMessage,
          files: ['https://example.com/file1.pdf', 'https://example.com/file2.jpg'],
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(messageWithFiles));

        const payload = createPayload();
        const envelope = await handler.handleWebhook(payload);

        expect(envelope?.content.attachments).toHaveLength(2);
        expect(envelope?.content.attachments?.[0]).toEqual({
          type: 'file',
          url: 'https://example.com/file1.pdf',
        });
      });

      it('should include card attachments', async () => {
        const cardContent = {
          type: 'AdaptiveCard' as const,
          version: '1.3',
          body: [{ type: 'TextBlock', text: 'Hello' }],
        };
        const messageWithCards: WebexMessage = {
          ...mockMessage,
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive' as const,
              content: cardContent,
            },
          ],
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(messageWithCards));

        const payload = createPayload();
        const envelope = await handler.handleWebhook(payload);

        expect(envelope?.content.attachments).toHaveLength(1);
        expect(envelope?.content.attachments?.[0]).toEqual({
          type: 'card',
          content: cardContent,
        });
      });

      it('should include mentions in metadata', async () => {
        const messageWithMentions: WebexMessage = {
          ...mockMessage,
          mentionedPeople: ['user-1', 'user-2'],
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(messageWithMentions));

        const payload = createPayload();
        const envelope = await handler.handleWebhook(payload);

        expect(envelope?.metadata.mentions).toEqual(['user-1', 'user-2']);
      });

      it('should include parentId in metadata', async () => {
        const messageWithParent: WebexMessage = {
          ...mockMessage,
          parentId: 'parent-message-123',
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(messageWithParent));

        const payload = createPayload();
        const envelope = await handler.handleWebhook(payload);

        expect(envelope?.metadata.parentId).toBe('parent-message-123');
      });
    });
  });

  describe('verifySignature', () => {
    it('should return true when no secret is configured', () => {
      const payload = {
        id: 'test',
        name: 'test',
        targetUrl: 'https://example.com',
        resource: 'messages' as const,
        event: 'created' as const,
        orgId: 'org',
        createdBy: 'user',
        appId: 'app',
        ownedBy: 'creator',
        status: 'active',
        created: '2024-01-01T00:00:00.000Z',
        actorId: 'actor',
        data: {
          id: 'msg',
          roomId: 'room',
          roomType: 'group' as const,
          personId: 'person',
          personEmail: 'person@example.com',
          created: '2024-01-01T00:00:00.000Z',
        },
      };
      expect(handler.verifySignature(payload, 'any-signature')).toBe(true);
    });
  });

  describe('webhook management', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await handler.initialize();
      mockFetch.mockClear();
    });

    describe('registerWebhooks', () => {
      it('should create webhooks after deleting existing ones with same URL', async () => {
        const existingWebhooks: PaginatedResponse<WebexWebhook> = {
          items: [
            {
              id: 'old-webhook-1',
              name: 'Old Webhook',
              targetUrl: 'https://example.com/webhook',
              resource: 'messages',
              event: 'created',
              status: 'active',
              created: '2024-01-01T00:00:00.000Z',
              orgId: 'org-123',
              createdBy: 'user-123',
              appId: 'app-123',
              ownedBy: 'creator',
            },
            {
              id: 'other-webhook',
              name: 'Other Webhook',
              targetUrl: 'https://other.com/webhook',
              resource: 'messages',
              event: 'created',
              status: 'active',
              created: '2024-01-01T00:00:00.000Z',
              orgId: 'org-123',
              createdBy: 'user-123',
              appId: 'app-123',
              ownedBy: 'creator',
            },
          ],
        };

        const newWebhook: WebexWebhook = {
          id: 'new-webhook-1',
          name: 'OpenClaw Message Handler',
          targetUrl: 'https://example.com/webhook',
          resource: 'messages',
          event: 'created',
          status: 'active',
          created: '2024-01-01T00:00:00.000Z',
          orgId: 'org-123',
          createdBy: 'user-123',
          appId: 'app-123',
          ownedBy: 'creator',
        };

        // List webhooks
        mockFetch.mockResolvedValueOnce(createMockResponse(existingWebhooks));
        // Delete old webhook with same URL
        mockFetch.mockResolvedValueOnce(createMockResponse({}, true, 204));
        // Create new webhook
        mockFetch.mockResolvedValueOnce(createMockResponse(newWebhook));

        const webhooks = await handler.registerWebhooks();

        expect(webhooks).toHaveLength(1);
        expect(webhooks[0].id).toBe('new-webhook-1');
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should include webhook secret when configured', async () => {
        const secretConfig = { ...config, webhookSecret: 'test-secret' };
        const secretHandler = new WebexWebhookHandler(secretConfig);
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
        await secretHandler.initialize();
        mockFetch.mockClear();

        mockFetch.mockResolvedValueOnce(createMockResponse({ items: [] }));
        mockFetch.mockResolvedValueOnce(
          createMockResponse({
            id: 'webhook-1',
            name: 'OpenClaw Message Handler',
            targetUrl: 'https://example.com/webhook',
            resource: 'messages',
            event: 'created',
            status: 'active',
            created: '2024-01-01T00:00:00.000Z',
            orgId: 'org-123',
            createdBy: 'user-123',
            appId: 'app-123',
            ownedBy: 'creator',
          })
        );

        await secretHandler.registerWebhooks();

        expect(mockFetch).toHaveBeenCalledWith(
          'https://webexapis.com/v1/webhooks',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"secret":"test-secret"'),
          })
        );
      });
    });

    describe('listWebhooks', () => {
      it('should return list of webhooks', async () => {
        const webhooksResponse: PaginatedResponse<WebexWebhook> = {
          items: [
            {
              id: 'webhook-1',
              name: 'Test Webhook',
              targetUrl: 'https://example.com/webhook',
              resource: 'messages',
              event: 'created',
              status: 'active',
              created: '2024-01-01T00:00:00.000Z',
              orgId: 'org-123',
              createdBy: 'user-123',
              appId: 'app-123',
              ownedBy: 'creator',
            },
          ],
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(webhooksResponse));

        const webhooks = await handler.listWebhooks();

        expect(webhooks).toHaveLength(1);
        expect(webhooks[0].id).toBe('webhook-1');
      });

      it('should throw error on failed request', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, false, 500, 'Internal Server Error'));

        await expect(handler.listWebhooks()).rejects.toThrow('Failed to list webhooks');
      });
    });

    describe('createWebhook', () => {
      it('should create a webhook', async () => {
        const newWebhook: WebexWebhook = {
          id: 'new-webhook',
          name: 'Test Webhook',
          targetUrl: 'https://example.com/webhook',
          resource: 'messages',
          event: 'created',
          status: 'active',
          created: '2024-01-01T00:00:00.000Z',
          orgId: 'org-123',
          createdBy: 'user-123',
          appId: 'app-123',
          ownedBy: 'creator',
        };
        mockFetch.mockResolvedValueOnce(createMockResponse(newWebhook));

        const webhook = await handler.createWebhook({
          name: 'Test Webhook',
          targetUrl: 'https://example.com/webhook',
          resource: 'messages',
          event: 'created',
        });

        expect(webhook.id).toBe('new-webhook');
      });

      it('should throw error on failed request', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({ message: 'Bad request' }, false, 400, 'Bad Request'));

        await expect(
          handler.createWebhook({
            name: 'Test',
            targetUrl: 'https://example.com',
            resource: 'messages',
            event: 'created',
          })
        ).rejects.toThrow('Failed to create webhook');
      });
    });

    describe('deleteWebhook', () => {
      it('should delete a webhook', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, true, 204));

        await expect(handler.deleteWebhook('webhook-123')).resolves.toBeUndefined();

        expect(mockFetch).toHaveBeenCalledWith(
          'https://webexapis.com/v1/webhooks/webhook-123',
          expect.objectContaining({
            method: 'DELETE',
          })
        );
      });

      it('should not throw for 404 response', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, false, 404, 'Not Found'));

        await expect(handler.deleteWebhook('nonexistent')).resolves.toBeUndefined();
      });

      it('should throw error for other failed responses', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, false, 500, 'Internal Server Error'));

        await expect(handler.deleteWebhook('webhook-123')).rejects.toThrow('Failed to delete webhook');
      });
    });
  });

  describe('getBotId', () => {
    it('should return null before initialization', () => {
      expect(handler.getBotId()).toBeNull();
    });

    it('should return bot ID after initialization', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBotInfo));
      await handler.initialize();

      expect(handler.getBotId()).toBe('bot-123');
    });
  });
});

describe('WebhookValidationError', () => {
  it('should create error with message', () => {
    const error = new WebhookValidationError('Test error');

    expect(error.name).toBe('WebhookValidationError');
    expect(error.message).toBe('Test error');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have proper stack trace', () => {
    const error = new WebhookValidationError('Test error');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('WebhookValidationError');
  });
});
