/**
 * Webex Webhook Handler Module
 */

import * as crypto from 'crypto';
import fetch from 'node-fetch';
import type {
  WebexChannelConfig,
  WebexWebhookPayload,
  WebexWebhookData,
  WebexMessage,
  WebexWebhook,
  CreateWebhookRequest,
  OpenClawEnvelope,
  OpenClawAttachment,
  PaginatedResponse,
} from './types';

const DEFAULT_API_BASE_URL = 'https://webexapis.com/v1';

/**
 * Matches a `<spark-mention>` at the very start of a message's HTML, past any
 * block wrappers Webex puts around it. Group 1 is the element's attributes,
 * group 2 its rendered text (the name the mention shows as, which is also what
 * lands in the message's plain-text `text` field).
 */
const LEADING_SPARK_MENTION =
  /^(?:\s|<p>|<div>|<span>|<br\s*\/?>)*<spark-mention\b([^>]*)>([\s\S]*?)<\/spark-mention>/i;
const MENTION_OBJECT_ID = /data-object-id\s*=\s*["']([^"']*)["']/i;

/**
 * Reduce a Webex person identifier to a comparable key.
 *
 * `mentionedPeople` carries base64 IDs (`Y2lzY29zcGFyazovL3...`), while a
 * mention's `data-object-id` may carry either that same base64 form or the bare
 * UUID it encodes, depending on how the message was authored. Decoding to the
 * trailing UUID makes both forms compare equal.
 */
function personIdKey(id: string): string {
  let raw = id;
  if (id.startsWith('Y2lzY29zcGFyazovL3')) {
    try {
      raw = Buffer.from(id, 'base64').toString('utf-8');
    } catch {
      raw = id;
    }
  }
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(raw);
  return (uuid ? uuid[1] : raw).toLowerCase();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip `name` from the start of `text`, along with any separator that follows
 * it, returning null when the text doesn't start with that name. The negative
 * lookahead keeps a name from matching a longer word it merely prefixes, so a
 * bot named "Test" doesn't turn "Testing 1 2 3" into "ing 1 2 3".
 */
function stripLeadingName(text: string, name: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(name)}(?![\\p{L}\\p{N}_])[\\s:,]*`, 'iu');
  const match = pattern.exec(text);
  return match ? text.slice(match[0].length) : null;
}

export class WebexWebhookHandler {
  private config: WebexChannelConfig;
  private apiBaseUrl: string;
  private botId: string | null = null;
  private botNames: string[] = [];

  constructor(config: WebexChannelConfig) {
    this.config = config;
    this.apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
  }

  /**
   * Initialize the webhook handler (fetch bot info)
   */
  async initialize(): Promise<void> {
    const botInfo = await this.getBotInfo();
    this.botId = botInfo.id;
    // Kept for the fallback path of stripBotMention() when a message has no
    // usable HTML to locate the mention in. Longest first so "Test Bot" wins
    // over a "Test" nickname that prefixes it.
    this.botNames = [botInfo.displayName, botInfo.nickName]
      .filter((name): name is string => Boolean(name && name.trim()))
      .map((name) => name.trim())
      .sort((a, b) => b.length - a.length);
  }

  /**
   * Handle an incoming webhook request
   */
  async handleWebhook(
    payload: WebexWebhookPayload,
    signature?: string
  ): Promise<OpenClawEnvelope | null> {
    // Verify webhook signature if secret is configured
    if (this.config.webhookSecret && signature) {
      if (!this.verifySignature(payload, signature)) {
        throw new WebhookValidationError('Invalid webhook signature');
      }
    }

    // Only handle message created events
    if (payload.resource !== 'messages' || payload.event !== 'created') {
      return null;
    }

    // Ignore messages from the bot itself
    if (payload.data.personId === this.botId) {
      return null;
    }

    // Check DM policy
    if (payload.data.roomType === 'direct') {
      if (!this.isAllowedSender(payload.data)) {
        return null;
      }
    }

    // Fetch full message details (webhook only contains IDs)
    const message = await this.fetchMessage(payload.data.id);

    // Normalize to OpenClaw envelope
    return this.normalizeMessage(message);
  }

  /**
   * Verify webhook signature using HMAC-SHA1
   */
  verifySignature(payload: WebexWebhookPayload, signature: string): boolean {
    if (!this.config.webhookSecret) {
      return true;
    }

    const hmac = crypto.createHmac('sha1', this.config.webhookSecret);
    hmac.update(JSON.stringify(payload));
    const expectedSignature = hmac.digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Check if the sender is allowed based on DM policy.
   *
   * This is the *only* DM gate for the plugin: OpenClaw core's dispatch
   * pipeline does not re-apply dmPolicy, so any value this method fails to
   * recognize would silently drop every direct message (commands included)
   * before it reaches core. The switch below is therefore exhaustive over all
   * valid `DmPolicy` values, and both spellings of the allowlist policy
   * (`'allowlist'`, the OpenClaw-canonical form, and `'allowlisted'`, the
   * manifest/schema form) are handled identically so the two config surfaces
   * can't disagree. `default` is reached only by genuinely invalid config and
   * fails safe (deny).
   */
  private isAllowedSender(data: WebexWebhookData): boolean {
    switch (this.config.dmPolicy) {
      case 'allow':
        return true;
      case 'deny':
        return false;
      case 'allowlist':
      case 'allowlisted':
      case 'pairing':
        // 'pairing' has no interactive handshake at the webhook layer, so it
        // gates on `allowFrom` exactly like the allowlist policies: only
        // pre-approved senders pass; unknown senders are held back rather than
        // let through to a channel that can't complete a pairing flow.
        if (!this.config.allowFrom || this.config.allowFrom.length === 0) {
          return false;
        }
        return this.config.allowFrom.includes(data.personId) ||
               this.config.allowFrom.includes(data.personEmail);
      default:
        return false;
    }
  }

  /**
   * Fetch full message details from Webex API
   */
  private async fetchMessage(messageId: string): Promise<WebexMessage> {
    const response = await fetch(`${this.apiBaseUrl}/messages/${messageId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch message: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<WebexMessage>;
  }

  /**
   * Remove a leading @mention of this bot from a message's plain text.
   *
   * In a group room Webex only delivers messages that @mention the bot, and the
   * message's `text` field renders that mention as the bot's name: typing
   * "@Test Bot /new" arrives as `text: "Test Bot /new"`. Anything downstream
   * that looks at the start of the text — most importantly OpenClaw's slash
   * command parser, which requires `CommandBody` to begin with "/" — would
   * otherwise never see the command, which is why commands work in DMs (no
   * mention, so no prefix) but silently fall through to the agent in group
   * rooms.
   *
   * The mention's rendered text is read out of `html` so the exact string being
   * stripped is known rather than guessed; `displayName`/`nickName` are only a
   * fallback for messages that arrive without usable HTML. Only a mention of
   * *this bot* at the very start is stripped — a message that leads with a
   * mention of someone else is left alone.
   */
  private stripBotMention(message: WebexMessage): string | undefined {
    const text = message.text;
    if (!text || !this.botId) {
      return text;
    }
    const botKey = personIdKey(this.botId);
    if (!message.mentionedPeople?.some((id) => personIdKey(id) === botKey)) {
      return text;
    }

    const fromHtml = message.html ? LEADING_SPARK_MENTION.exec(message.html) : null;
    if (fromHtml) {
      const objectId = MENTION_OBJECT_ID.exec(fromHtml[1])?.[1];
      // No id on the element: the bot is mentioned somewhere and this is the
      // leading mention, so treat it as the bot's.
      if (objectId && personIdKey(objectId) !== botKey) {
        return text;
      }
      const rendered = decodeHtmlEntities(fromHtml[2].replace(/<[^>]*>/g, '')).trim();
      if (rendered) {
        const stripped = stripLeadingName(text, rendered);
        if (stripped !== null) {
          return stripped;
        }
      }
    }

    for (const name of this.botNames) {
      const stripped = stripLeadingName(text, name);
      if (stripped !== null) {
        return stripped;
      }
    }

    return text;
  }

  /**
   * Normalize a Webex message to OpenClaw envelope format
   */
  private normalizeMessage(message: WebexMessage): OpenClawEnvelope {
    const attachments: OpenClawAttachment[] = [];

    // Convert file attachments
    if (message.files && message.files.length > 0) {
      for (const fileUrl of message.files) {
        attachments.push({
          type: 'file',
          url: fileUrl,
        });
      }
    }

    // Convert card attachments
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        attachments.push({
          type: 'card',
          content: attachment.content,
        });
      }
    }

    return {
      id: message.id,
      channel: 'webex',
      conversationId: message.roomId,
      author: {
        id: message.personId,
        email: message.personEmail,
        displayName: undefined, // Would need additional API call to get
        isBot: false, // Messages from bot are filtered out earlier
      },
      content: {
        text: this.stripBotMention(message),
        markdown: message.markdown,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      metadata: {
        roomType: message.roomType,
        roomId: message.roomId,
        timestamp: message.created,
        mentions: message.mentionedPeople,
        parentId: message.parentId,
        raw: message,
      },
    };
  }

  /**
   * Register webhooks with Webex
   */
  async registerWebhooks(): Promise<WebexWebhook[]> {
    // First, list existing webhooks and remove duplicates
    const existing = await this.listWebhooks();
    const targetUrl = this.config.webhookUrl;

    // Delete existing webhooks with the same target URL
    for (const webhook of existing) {
      if (webhook.targetUrl === targetUrl) {
        await this.deleteWebhook(webhook.id);
      }
    }

    // Create new webhooks for messages
    const webhooks: WebexWebhook[] = [];

    // Webhook for new messages
    const messageCreatedWebhook = await this.createWebhook({
      name: 'OpenClaw Message Handler',
      targetUrl,
      resource: 'messages',
      event: 'created',
      secret: this.config.webhookSecret,
    });
    webhooks.push(messageCreatedWebhook);

    return webhooks;
  }

  /**
   * List all webhooks
   */
  async listWebhooks(): Promise<WebexWebhook[]> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list webhooks: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PaginatedResponse<WebexWebhook>;
    return data.items;
  }

  /**
   * Create a webhook
   */
  async createWebhook(request: CreateWebhookRequest): Promise<WebexWebhook> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create webhook: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<WebexWebhook>;
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete webhook: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Get bot information
   */
  private async getBotInfo(): Promise<{
    id: string;
    displayName: string;
    nickName?: string;
    emails: string[];
  }> {
    const response = await fetch(`${this.apiBaseUrl}/people/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get bot info: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{
      id: string;
      displayName: string;
      nickName?: string;
      emails: string[];
    }>;
  }

  /**
   * Get the bot ID (after initialization)
   */
  getBotId(): string | null {
    return this.botId;
  }
}

/**
 * Custom error for webhook validation failures
 */
export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WebhookValidationError);
    }
  }
}
