# @jimiford/webex

OpenClaw channel plugin for Cisco Webex messaging. Enables your OpenClaw gateway to send and receive messages via Webex bots.

## Features

- **Direct Messages (1:1)**: Send and receive private messages with users
- **Space/Room Messages**: Communicate in Webex spaces and rooms
- **Attachments**: Send files via public URLs
- **Adaptive Cards**: Rich interactive message cards
- **Threaded Replies**: Support for message threading
- **Webhook Integration**: Real-time message reception
- **Automatic Retries**: Configurable retry logic with exponential backoff
- **Message Normalization**: Converts Webex messages to OpenClaw's envelope format

## Installation

```bash
npm install @jimiford/webex
```

## Prerequisites

### 1. Create a Webex Bot

1. Go to [Webex Developer Portal](https://developer.webex.com)
2. Sign in with your Webex account
3. Navigate to **My Webex Apps** → **Create a New App**
4. Select **Create a Bot**
5. Fill in the bot details:
   - Bot Name: Your bot's display name
   - Bot Username: Unique identifier (e.g., `mybot@webex.bot`)
   - Icon: Upload or select an icon
   - Description: Brief description of your bot
6. Click **Add Bot**
7. **Important**: Copy the **Bot Access Token** - you'll only see it once!

### 2. Set Up a Public Webhook URL

Your webhook endpoint must be publicly accessible. Options:

- **Production**: Deploy to a cloud provider with HTTPS
- **Development**: Use [ngrok](https://ngrok.com) to expose localhost:
  ```bash
  ngrok http 3000
  ```

## Configuration

```typescript
import { createWebexChannel, WebexChannelConfig } from '@jimiford/webex';

const config: WebexChannelConfig = {
  // Required: Your Webex bot access token
  token: 'YOUR_BOT_ACCESS_TOKEN',

  // Required: Public URL for receiving webhooks
  webhookUrl: 'https://your-domain.com/webhooks/webex',

  // Required: Policy for handling direct messages
  // - 'allow': Accept DMs from anyone
  // - 'deny': Reject all DMs
  // - 'allowlisted': Only accept from specified users
  dmPolicy: 'allow',

  // Optional: List of allowed person IDs or emails (when dmPolicy is 'allowlisted')
  allowFrom: ['user@example.com', 'Y2lzY29zcGFyazov...'],

  // Optional: Secret for webhook signature verification
  webhookSecret: 'your-webhook-secret',

  // Optional: Custom API base URL (default: https://webexapis.com/v1)
  apiBaseUrl: 'https://webexapis.com/v1',

  // Optional: Maximum retry attempts (default: 3)
  maxRetries: 3,

  // Optional: Retry delay in ms (default: 1000)
  retryDelayMs: 1000,

  // Optional: Post an immediate "seen" message on inbound and edit it in
  // place with the reply, since Webex bots can't emit native read receipts
  // (default: true). See "Seen indicator" below. Set false to suppress the
  // extra message, e.g. in group spaces.
  seenIndicator: true,
};
```

### Seen indicator

Webex bots cannot emit the native "seen" read receipt that regular users produce, so a message the bot has received shows no acknowledgement until it actually replies — which can be a long, silent gap while the agent works.

When `seenIndicator` is enabled (the default), the OpenClaw plugin posts an immediate `👀 Seen — thinking…` placeholder on inbound and then **edits that same message in place** with the first block of the reply (later blocks are posted as new messages). The sender gets an instant "received" signal with no leftover placeholder. It's best-effort — if the placeholder can't be posted, or the edit fails (Webex allows at most 10 edits per message and can't edit messages with attachments), the reply is sent as a normal message instead; if the reply turns out empty, the placeholder is deleted.

Set `seenIndicator: false` to turn this off — for example in group spaces, where the placeholder is visible to everyone.

> **Note:** this behavior lives in the OpenClaw plugin's reply pipeline (`channels.webex.seenIndicator`, per account). When using the standalone `WebexChannel` class you drive your own send loop, so the flag has no effect there — replicate the pattern with `sender.editMessage()` if you want it.

## Usage

### Basic Setup

```typescript
import { createWebexChannel } from '@jimiford/webex';

async function main() {
  // Create and initialize the channel
  const channel = createWebexChannel();
  await channel.initialize({
    token: process.env.WEBEX_BOT_TOKEN!,
    webhookUrl: process.env.WEBHOOK_URL!,
    dmPolicy: 'allow',
  });

  // Register webhooks with Webex
  await channel.registerWebhooks();

  // Register a message handler
  channel.onMessage(async (envelope) => {
    console.log('Received message:', envelope);

    // Echo the message back
    await channel.send({
      to: envelope.conversationId,
      content: { text: `You said: ${envelope.content.text}` },
    });
  });

  console.log('Webex channel ready!');
}

main().catch(console.error);
```

### Sending Messages

```typescript
// Send to a room
await channel.sendText('roomId', 'Hello, room!');

// Send markdown
await channel.sendMarkdown('roomId', '**Bold** and _italic_');

// Send direct message
await channel.sendDirect('user@example.com', 'Hello!');

// Reply in a thread
await channel.reply('roomId', 'parentMessageId', 'This is a reply');

// Send with full options
await channel.send({
  to: 'roomId',
  content: {
    text: 'Plain text fallback',
    markdown: '**Rich** content',
    files: ['https://example.com/image.png'],
  },
  parentId: 'threadParentId',
});
```

### Handling Webhooks

Set up an HTTP endpoint to receive webhooks:

```typescript
import express from 'express';
import { createWebexChannel } from '@jimiford/webex';

const app = express();
app.use(express.json());

const channel = createWebexChannel();

// Initialize channel (do this on startup)
await channel.initialize({
  token: process.env.WEBEX_BOT_TOKEN!,
  webhookUrl: 'https://your-domain.com/webhooks/webex',
  dmPolicy: 'allow',
  webhookSecret: process.env.WEBHOOK_SECRET,
});

// Webhook endpoint
app.post('/webhooks/webex', async (req, res) => {
  try {
    const signature = req.headers['x-spark-signature'] as string;
    const envelope = await channel.handleWebhook(req.body, signature);

    if (envelope) {
      // Process the message
      console.log('Message from:', envelope.author.email);
      console.log('Content:', envelope.content.text);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

app.listen(3000);
```

### OpenClaw Envelope Format

Incoming messages are normalized to this format:

```typescript
interface OpenClawEnvelope {
  id: string;                    // Webex message ID
  channel: 'webex';              // Channel identifier
  conversationId: string;        // Room ID
  author: {
    id: string;                  // Person ID
    email?: string;              // Email address
    displayName?: string;        // Display name
    isBot: boolean;              // Always false (bot messages filtered)
  };
  content: {
    text?: string;               // Plain text content
    markdown?: string;           // Markdown content
    attachments?: Array<{
      type: 'file' | 'card';
      url?: string;              // File URL
      content?: unknown;         // Card content
    }>;
  };
  metadata: {
    roomType: 'direct' | 'group';
    roomId: string;
    timestamp: string;           // ISO 8601
    mentions?: string[];         // Mentioned person IDs
    parentId?: string;           // Thread parent message ID
    raw: WebexMessage;           // Original Webex message
  };
}
```

## Advanced Usage

### Direct Sender Access

```typescript
const sender = channel.getSender();

// Get message details
const message = await sender.getMessage('messageId');

// Delete a message
await sender.deleteMessage('messageId');
```

### Direct Webhook Handler Access

```typescript
const webhookHandler = channel.getWebhookHandler();

// List existing webhooks
const webhooks = await webhookHandler.listWebhooks();

// Delete a webhook
await webhookHandler.deleteWebhook('webhookId');
```

### Error Handling

```typescript
import { WebexApiRequestError } from '@jimiford/webex';

try {
  await channel.send({ to: 'invalid', content: { text: 'test' } });
} catch (error) {
  if (error instanceof WebexApiRequestError) {
    console.error('API Error:', error.message);
    console.error('Status:', error.statusCode);
    console.error('Tracking ID:', error.trackingId);
  }
}
```

## API Reference

### WebexChannel

| Method | Description |
|--------|-------------|
| `initialize(config)` | Initialize with configuration |
| `send(message)` | Send a message |
| `sendText(roomId, text)` | Send plain text to a room |
| `sendMarkdown(roomId, md)` | Send markdown to a room |
| `sendDirect(to, text)` | Send direct message |
| `reply(roomId, parentId, text)` | Send threaded reply |
| `handleWebhook(payload, sig?)` | Process incoming webhook |
| `onMessage(handler)` | Register message handler |
| `offMessage(handler)` | Remove message handler |
| `registerWebhooks()` | Register webhooks with Webex |
| `shutdown()` | Cleanup and shutdown |

## Environment Variables

Recommended environment variables:

```bash
WEBEX_BOT_TOKEN=your_bot_access_token
WEBHOOK_URL=https://your-domain.com/webhooks/webex
WEBHOOK_SECRET=your_webhook_secret
```

## Troubleshooting

### Bot not receiving messages

1. Ensure webhooks are registered: `await channel.registerWebhooks()`
2. Verify your webhook URL is publicly accessible
3. Check that the bot is added to the room/space
4. For DMs, the user must message the bot first

### "Invalid webhook signature" errors

1. Ensure `webhookSecret` matches the secret used when creating webhooks
2. Verify the signature header name: `x-spark-signature`

### Rate limiting

The plugin includes automatic retry with exponential backoff for rate-limited requests. Adjust `maxRetries` and `retryDelayMs` in config if needed.

## Security Considerations

When connecting a Webex bot to OpenClaw, keep these security implications in mind:

### Access Control

- **DM Policy**: The `dmPolicy` setting controls who can interact with your bot:
  - `allow`: Anyone can message the bot and receive responses (use with caution)
  - `deny`: The bot won't respond to direct messages
  - `allowlisted`: Only users in the `allowFrom` list receive responses
- **Recommendation**: Use `allowlisted` in production and explicitly specify trusted users

### Bot Token Permissions

- The bot access token can read messages sent to the bot and send replies
- Keep your token secret — never commit it to version control
- Rotate tokens periodically via the [Webex Developer Portal](https://developer.webex.com)

### Webhook Security

- **Always use a webhook secret** in production to verify incoming requests
- The `webhookSecret` enables HMAC-SHA1 signature verification
- Without verification, attackers could send fake webhook payloads to your endpoint

### Network Exposure

- Your webhook endpoint must be publicly accessible for Webex to deliver messages
- Use HTTPS in production (required by Webex)
- Consider IP allowlisting if your infrastructure supports it
- For development, tools like ngrok create temporary public URLs

### OpenClaw Agent Access

- Messages received by the bot flow through your OpenClaw agent
- The agent has access to whatever tools you've configured (file access, web browsing, etc.)
- Treat bot conversations with the same security considerations as direct OpenClaw access
- Review your agent's tool permissions and workspace access

### Best Practices

1. Start with `dmPolicy: 'deny'` or `dmPolicy: 'allowlisted'` and explicitly allow trusted users
2. Always configure a `webhookSecret` for production deployments
3. Monitor bot activity through Webex admin tools and OpenClaw logs
4. Use separate bots for development and production environments
5. Regularly audit the `allowFrom` list

## License

MIT
