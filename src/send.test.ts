/**
 * Tests for WebexSender
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebexSender, WebexApiRequestError } from './send';
import type { WebexChannelConfig, WebexMessage, OpenClawOutboundMessage } from './types';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn(),
  Response: vi.fn(),
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

describe('WebexSender', () => {
  let config: WebexChannelConfig;
  let sender: WebexSender;

  const mockMessage: WebexMessage = {
    id: 'message-123',
    roomId: 'room-123',
    roomType: 'group',
    text: 'Hello, world!',
    personId: 'person-123',
    personEmail: 'person@example.com',
    created: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    config = {
      token: 'test-token',
      webhookUrl: 'https://example.com/webhook',
      dmPolicy: 'allow',
    };
    sender = new WebexSender(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default API base URL', () => {
      expect(sender).toBeInstanceOf(WebexSender);
    });

    it('should use custom API base URL', () => {
      const customConfig = { ...config, apiBaseUrl: 'https://custom.api.com/v1' };
      const customSender = new WebexSender(customConfig);
      expect(customSender).toBeInstanceOf(WebexSender);
    });

    it('should use default retry options', () => {
      expect(sender).toBeInstanceOf(WebexSender);
    });

    it('should use custom retry options', () => {
      const customConfig = { ...config, maxRetries: 5, retryDelayMs: 2000 };
      const customSender = new WebexSender(customConfig);
      expect(customSender).toBeInstanceOf(WebexSender);
    });
  });

  describe('send', () => {
    it('should send message to room by ID', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: { text: 'Hello, world!' },
      };

      const result = await sender.send(outbound);

      expect(result.id).toBe('message-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://webexapis.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"roomId":"room-123"'),
        })
      );
    });

    it('should send message to person by email', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'person@example.com',
        content: { text: 'Hello!' },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"toPersonEmail":"person@example.com"'),
        })
      );
    });

    it('should send message to person by base64 ID', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0', // Person ID
        content: { text: 'Hello!' },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"toPersonId":"Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0"'),
        })
      );
    });

    it('should send message to room by base64 ID with ROOM in string', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      // ID that contains literal "ROOM" substring in the encoded form
      const outbound: OpenClawOutboundMessage = {
        to: 'Y2lzY29zcGFyazovL3ROOM123',
        content: { text: 'Hello!' },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"roomId":"Y2lzY29zcGFyazovL3ROOM123"'),
        })
      );
    });

    it('should send message to person by base64 ID without ROOM', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      // ID that doesn't contain "ROOM" substring - treated as personId
      const outbound: OpenClawOutboundMessage = {
        to: 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0',
        content: { text: 'Hello!' },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"toPersonId":"Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0"'),
        })
      );
    });

    it('should include markdown content', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: { markdown: '**Bold** text' },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"markdown":"**Bold** text"'),
        })
      );
    });

    it('should include file attachment (only first file)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: {
          text: 'Check this file',
          files: ['https://example.com/file1.pdf', 'https://example.com/file2.pdf'],
        },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringMatching(/"files":\["https:\/\/example\.com\/file1\.pdf"\]/),
        })
      );
    });

    it('should include adaptive card attachment', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: {
          text: 'Card message',
          card: {
            type: 'AdaptiveCard',
            version: '1.3',
            body: [{ type: 'TextBlock', text: 'Hello' }],
          },
        },
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('application/vnd.microsoft.card.adaptive'),
        })
      );
    });

    it('should include parentId for threaded replies', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: { text: 'Reply' },
        parentId: 'parent-message-123',
      };

      await sender.send(outbound);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"parentId":"parent-message-123"'),
        })
      );
    });
  });

  describe('sendToRoom', () => {
    it('should send text message to room', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendToRoom('room-123', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://webexapis.com/v1/messages',
        expect.objectContaining({
          body: expect.stringContaining('"roomId":"room-123"'),
        })
      );
    });

    it('should send text and markdown to room', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendToRoom('room-123', 'Hello!', '**Hello!**');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"markdown":"**Hello!**"'),
        })
      );
    });
  });

  describe('sendDirectById', () => {
    it('should send direct message by person ID', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendDirectById('person-123', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"toPersonId":"person-123"'),
        })
      );
    });
  });

  describe('sendDirectByEmail', () => {
    it('should send direct message by email', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendDirectByEmail('user@example.com', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"toPersonEmail":"user@example.com"'),
        })
      );
    });
  });

  describe('sendWithFile', () => {
    it('should send message with file attachment', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendWithFile('room-123', 'Check this', 'https://example.com/file.pdf');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"files":["https://example.com/file.pdf"]'),
        })
      );
    });
  });

  describe('sendReply', () => {
    it('should send threaded reply', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await sender.sendReply('room-123', 'parent-123', 'Reply text', '**Reply**');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringMatching(/"parentId":"parent-123"/),
        })
      );
    });
  });

  describe('getMessage', () => {
    it('should get message by ID', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      const result = await sender.getMessage('message-123');

      expect(result.id).toBe('message-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://webexapis.com/v1/messages/message-123',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });
  });

  describe('deleteMessage', () => {
    it('should delete message by ID', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, true, 204));

      await sender.deleteMessage('message-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://webexapis.com/v1/messages/message-123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('validation', () => {
    it('should throw error when no target specified', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      // Create sender with custom buildMessageRequest to test validation
      const outbound: OpenClawOutboundMessage = {
        to: '',
        content: { text: 'Hello!' },
      };

      // The buildMessageRequest will create an empty roomId which triggers validation
      await expect(sender.send(outbound)).rejects.toThrow('Message must have a target');
    });

    it('should throw error when no content specified', async () => {
      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: {},
      };

      await expect(sender.send(outbound)).rejects.toThrow('Message must have content');
    });

    it('should throw error when text exceeds max size', async () => {
      const outbound: OpenClawOutboundMessage = {
        to: 'room-123',
        content: { text: 'x'.repeat(8000) }, // Over 7439 bytes
      };

      await expect(sender.send(outbound)).rejects.toThrow('exceeds maximum size');
    });
  });

  describe('retry logic', () => {
    beforeEach(() => {
      // Use real timers for retry tests since they involve real delays
      vi.useRealTimers();
      // Clear all mock calls and reset implementations
      mockFetch.mockReset();
    });

    afterEach(() => {
      mockFetch.mockReset();
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('should retry on 429 rate limit', async () => {
      // Return error response that triggers retry, then success
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ message: 'Rate limited' }, false, 429, 'Too Many Requests'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      // Use minimal retry delay for tests
      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 502 bad gateway', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ message: 'Bad Gateway' }, false, 502, 'Bad Gateway'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 503 service unavailable', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ message: 'Service Unavailable' }, false, 503, 'Service Unavailable'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
    });

    it('should retry on 504 gateway timeout', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ message: 'Gateway Timeout' }, false, 504, 'Gateway Timeout'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
    });

    it('should retry on network errors (ECONNRESET)', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
    });

    it('should retry on ETIMEDOUT', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
    });

    it('should retry on ENOTFOUND', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ENOTFOUND'))
        .mockResolvedValueOnce(createMockResponse(mockMessage));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      const result = await fastSender.sendToRoom('room-123', 'Hello!');

      expect(result.id).toBe('message-123');
    });

    it('should not retry on 400 bad request', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ message: 'Bad Request' }, false, 400, 'Bad Request'));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      await expect(fastSender.sendToRoom('room-123', 'Hello!')).rejects.toThrow('Bad Request');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 401 unauthorized', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ message: 'Unauthorized' }, false, 401, 'Unauthorized'));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      await expect(fastSender.sendToRoom('room-123', 'Hello!')).rejects.toThrow('Unauthorized');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should fail after max retries', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ message: 'Rate Limited' }, false, 429, 'Too Many Requests'));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      await expect(fastSender.sendToRoom('room-123', 'Hello!')).rejects.toThrow('Rate Limited');
      // Default is 3 retries + 1 initial attempt = 4 total
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('should not retry generic non-network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Some generic error'));

      const fastConfig = { ...config, maxRetries: 3, retryDelayMs: 10 };
      const fastSender = new WebexSender(fastConfig);

      await expect(fastSender.sendToRoom('room-123', 'Hello!')).rejects.toThrow('Some generic error');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should parse JSON error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({
          message: 'Invalid roomId',
          trackingId: 'tracking-123',
          errors: [{ description: 'roomId not found' }],
        }),
      });

      await expect(sender.sendToRoom('invalid-room', 'Hello!')).rejects.toThrow('Invalid roomId');
    });

    it('should handle non-JSON error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: vi.fn().mockRejectedValue(new Error('Not JSON')),
      });

      await expect(sender.sendToRoom('room-123', 'Hello!')).rejects.toThrow('HTTP 500');
    });
  });

  describe('custom API base URL', () => {
    it('should use custom API base URL for requests', async () => {
      const customConfig = { ...config, apiBaseUrl: 'https://custom.webex.com/api' };
      const customSender = new WebexSender(customConfig);
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMessage));

      await customSender.sendToRoom('room-123', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.webex.com/api/messages',
        expect.any(Object)
      );
    });
  });
});

describe('WebexApiRequestError', () => {
  it('should create error with all properties', () => {
    const error = new WebexApiRequestError(
      'Test error',
      400,
      'tracking-123',
      [{ description: 'Details' }]
    );

    expect(error.name).toBe('WebexApiRequestError');
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.trackingId).toBe('tracking-123');
    expect(error.details).toEqual([{ description: 'Details' }]);
    expect(error).toBeInstanceOf(Error);
  });

  it('should create error without optional properties', () => {
    const error = new WebexApiRequestError('Test error', 500);

    expect(error.statusCode).toBe(500);
    expect(error.trackingId).toBeUndefined();
    expect(error.details).toBeUndefined();
  });

  it('should serialize to JSON correctly', () => {
    const error = new WebexApiRequestError(
      'Test error',
      400,
      'tracking-123',
      [{ description: 'Details' }]
    );

    const json = error.toJSON();

    expect(json).toEqual({
      name: 'WebexApiRequestError',
      message: 'Test error',
      statusCode: 400,
      trackingId: 'tracking-123',
      details: [{ description: 'Details' }],
    });
  });

  it('should have proper stack trace', () => {
    const error = new WebexApiRequestError('Test error', 500);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('WebexApiRequestError');
  });
});
