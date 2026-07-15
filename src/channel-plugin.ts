/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ChannelPlugin,
  PluginRuntime,
} from "openclaw/plugin-sdk";

import { WebexSender } from "./send";
import { WebexWebhookHandler } from "./webhook";
import type { WebexChannelConfig, WebexWebhookPayload } from "./types";

// Store the plugin runtime for use in HTTP handlers
let pluginRuntime: PluginRuntime | null = null;

export function setPluginRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
}

/** Resolved account configuration */
export interface ResolvedWebexAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: WebexChannelConfig;
  token?: string;
  webhookUrl?: string;
}

/** Core config type for accessing channels.webex */
interface CoreConfig {
  channels?: {
    webex?: WebexChannelSection;
    defaults?: {
      groupPolicy?: string;
    };
  };
}

interface WebexChannelSection {
  enabled?: boolean;
  name?: string;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  dmPolicy?: "allow" | "deny" | "allowlisted" | "pairing";
  allowFrom?: string[];
  apiBaseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  accounts?: Record<string, WebexAccountConfig>;
}

interface WebexAccountConfig {
  enabled?: boolean;
  name?: string;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  dmPolicy?: "allow" | "deny" | "allowlisted" | "pairing";
  allowFrom?: string[];
  apiBaseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_ACCOUNT_ID = "default";

/** Webhook target registration for HTTP handler */
type WebexWebhookTarget = {
  account: ResolvedWebexAccount;
  config: WebexChannelConfig;
  webhookHandler: WebexWebhookHandler;
};

const webhookTargets = new Map<string, WebexWebhookTarget>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

export function registerWebexWebhookTarget(
  path: string,
  target: WebexWebhookTarget
): () => void {
  const key = normalizeWebhookPath(path);
  webhookTargets.set(key, target);
  return () => {
    webhookTargets.delete(key);
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body);
        resolve({ ok: true, value: parsed });
      } catch {
        resolve({ ok: false, error: "invalid json" });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Create the webhook handler with access to the plugin runtime.
 * Returns a handler function that can process incoming Webex webhook requests.
 */
export function createWebhookHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = normalizeWebhookPath(url.pathname);

    // Check if path matches /webhooks/webex/*
    if (!path.startsWith("/webhooks/webex/")) {
      return false;
    }

    const target = webhookTargets.get(path);
    if (!target) {
      return false;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.ok) {
      res.statusCode = body.error === "payload too large" ? 413 : 400;
      res.end(body.error ?? "invalid payload");
      return true;
    }

    const { account, webhookHandler } = target;

    try {
      const signature = req.headers["x-spark-signature"] as string | undefined;
      const payload = body.value as WebexWebhookPayload;

      const envelope = await webhookHandler.handleWebhook(payload, signature);

      if (envelope && pluginRuntime) {
        // Load config using the plugin runtime (cast to any for internal API access)
        const runtime = pluginRuntime as any;
        const cfg = runtime.config?.loadConfig?.() ?? {};
        
        // Build the context payload for OpenClaw's message pipeline
        const ctxPayload = {
          Body: envelope.content.text ?? "",
          RawBody: envelope.content.text ?? "",
          CommandBody: envelope.content.text ?? "",
          From: `webex:${envelope.author.id}`,
          To: `webex:${envelope.conversationId}`,
          SessionKey: `agent:main:webex:${envelope.conversationId}`,
          AccountId: account.accountId,
          ChatType: envelope.metadata.roomType === "direct" ? "direct" : "group",
          SenderName: envelope.author.displayName ?? envelope.author.email ?? envelope.author.id,
          SenderId: envelope.author.id,
          Provider: "webex",
          Surface: "webex",
          MessageSid: envelope.id,
          Timestamp: envelope.metadata.timestamp,
          OriginatingChannel: "webex",
          OriginatingTo: `webex:${envelope.conversationId}`,
          MessageThreadId: envelope.metadata.parentId,
        };

        // Use the plugin runtime's dispatch function (cast to any for internal API)
        const dispatchReply = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
        
        if (dispatchReply) {
          // Create a sender for replies
          const sender = new WebexSender(account.config);
          
          await dispatchReply({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; media?: string }) => {
                if (payload.text) {
                  await sender.send({
                    to: envelope.conversationId,
                    content: { text: payload.text },
                    parentId: envelope.metadata.parentId,
                  });
                }
              },
              onError: (err: Error) => {
                console.error(`[webex:${account.accountId}] reply dispatch error: ${err.message}`);
              },
            },
            replyOptions: {},
          });
        } else {
          console.warn(`[webex:${account.accountId}] dispatchReply not available in plugin runtime`);
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return true;
    } catch (err) {
      console.error(
        `[webex:${account.accountId}] webhook error: ${err instanceof Error ? err.message : err}`
      );
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal error" }));
      return true;
    }
  };
}

function listWebexAccountIds(cfg: CoreConfig): string[] {
  const section = cfg.channels?.webex;
  if (!section) return [];

  const ids: string[] = [];

  // Check for top-level config (default account)
  if (section.token) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // Check for named accounts
  if (section.accounts) {
    for (const id of Object.keys(section.accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID) {
        ids.push(id);
      }
    }
  }

  return ids;
}

function resolveWebexAccount(opts: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedWebexAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = opts;
  const section = cfg.channels?.webex;

  if (!section) {
    return {
      accountId,
      enabled: false,
      configured: false,
      config: {} as WebexChannelConfig,
    };
  }

  // Check for named account first
  const namedAccount = section.accounts?.[accountId];

  if (namedAccount) {
    const token = namedAccount.token ?? section.token;
    const webhookUrl = namedAccount.webhookUrl ?? section.webhookUrl;

    return {
      accountId,
      name: namedAccount.name,
      enabled: namedAccount.enabled !== false,
      configured: Boolean(token && webhookUrl),
      token,
      webhookUrl,
      config: {
        token: token ?? "",
        webhookUrl: webhookUrl ?? "",
        webhookSecret: namedAccount.webhookSecret ?? section.webhookSecret,
        dmPolicy: namedAccount.dmPolicy ?? section.dmPolicy ?? "allow",
        allowFrom: namedAccount.allowFrom ?? section.allowFrom,
        apiBaseUrl: namedAccount.apiBaseUrl ?? section.apiBaseUrl,
        maxRetries: namedAccount.maxRetries ?? section.maxRetries,
        retryDelayMs: namedAccount.retryDelayMs ?? section.retryDelayMs,
      },
    };
  }

  // Fall back to top-level config (default account)
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      accountId,
      name: section.name,
      enabled: section.enabled !== false,
      configured: Boolean(section.token && section.webhookUrl),
      token: section.token,
      webhookUrl: section.webhookUrl,
      config: {
        token: section.token ?? "",
        webhookUrl: section.webhookUrl ?? "",
        webhookSecret: section.webhookSecret,
        dmPolicy: section.dmPolicy ?? "allow",
        allowFrom: section.allowFrom,
        apiBaseUrl: section.apiBaseUrl,
        maxRetries: section.maxRetries,
        retryDelayMs: section.retryDelayMs,
      },
    };
  }

  // Account not found
  return {
    accountId,
    enabled: false,
    configured: false,
    config: {} as WebexChannelConfig,
  };
}

const meta = {
  id: "webex",
  label: "Webex",
  selectionLabel: "Cisco Webex",
  docsPath: "/channels/webex",
  docsLabel: "webex",
  blurb: "Cisco Webex messaging via bot webhooks.",
  order: 75,
  aliases: ["cisco-webex"],
};

export const webexPlugin: ChannelPlugin<ResolvedWebexAccount> = {
  id: "webex",
  meta,

  capabilities: {
    chatTypes: ["direct", "group"],
    threads: true,
    media: true,
  },

  reload: { configPrefixes: ["channels.webex"] },

  config: {
    listAccountIds: (cfg) => listWebexAccountIds(cfg as CoreConfig),

    resolveAccount: (cfg, accountId) =>
      resolveWebexAccount({ cfg: cfg as CoreConfig, accountId }),

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const config = cfg as CoreConfig;
      const section = config.channels?.webex ?? {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...config,
          channels: {
            ...config.channels,
            webex: {
              ...section,
              enabled,
            },
          },
        };
      }

      return {
        ...config,
        channels: {
          ...config.channels,
          webex: {
            ...section,
            accounts: {
              ...section.accounts,
              [accountId]: {
                ...section.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const config = cfg as CoreConfig;
      const section = config.channels?.webex ?? {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { token, webhookUrl, webhookSecret, dmPolicy, allowFrom, ...rest } = section;
        return {
          ...config,
          channels: {
            ...config.channels,
            webex: rest,
          },
        };
      }

      const accounts = { ...section.accounts };
      delete accounts[accountId];

      return {
        ...config,
        channels: {
          ...config.channels,
          webex: {
            ...section,
            accounts,
          },
        },
      };
    },

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
    }),

    resolveAllowFrom: ({ cfg }) =>
      ((cfg as CoreConfig).channels?.webex?.allowFrom ?? []).map(String),

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => entry.trim().toLowerCase()),
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      const policy = account.config.dmPolicy ?? "allow";
      // Map "allowlisted" to "allowlist" for OpenClaw compatibility
      const normalizedPolicy = policy === "allowlisted" ? "allowlist" : policy;

      return {
        policy: normalizedPolicy as "allow" | "deny" | "allowlist" | "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.webex.dmPolicy",
        allowFromPath: "channels.webex.allowFrom",
        approveHint: "Add user ID or email to channels.webex.allowFrom",
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },

  threading: {
    resolveReplyToMode: () => "off",
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.MessageThreadId != null
        ? String(context.MessageThreadId)
        : context.ReplyToId,
      hasRepliedRef,
    }),
  },

  messaging: {
    normalizeTarget: (raw: string) => {
      let normalized = raw.trim();
      if (!normalized) return undefined;
      if (normalized.toLowerCase().startsWith("webex:")) {
        normalized = normalized.slice("webex:".length).trim();
      }
      return normalized || undefined;
    },
    targetResolver: {
      // The host calls looksLikeId(raw, normalized) - raw still carries the
      // "webex:" prefix stripped by normalizeTarget above, so check the
      // normalized form (falling back to raw if it's ever omitted).
      looksLikeId: (raw, normalized) => {
        const trimmed = (normalized ?? raw).trim();
        if (!trimmed) return false;
        // Webex IDs are base64-encoded and start with a specific prefix
        if (trimmed.startsWith("Y2lzY29zcGFyazovL3")) return true;
        // Also accept emails
        return trimmed.includes("@");
      },
      hint: "<roomId|personId|email>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 7000, // Webex has a 7439 byte limit

    // The host never passes a pre-resolved account into outbound hooks - only
    // cfg + accountId - so every method below must resolve it itself via
    // resolveWebexAccount, the same helper config.resolveAccount uses.
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const account = resolveWebexAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      const sender = new WebexSender(account.config);

      const result = await sender.send({
        to,
        content: { text },
        parentId: replyToId ?? undefined,
      });

      return {
        channel: "webex",
        messageId: result.id,
        roomId: result.roomId,
      };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
      const account = resolveWebexAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      const sender = new WebexSender(account.config);

      const result = await sender.send({
        to,
        content: {
          text,
          files: mediaUrl ? [mediaUrl] : undefined,
        },
        parentId: replyToId ?? undefined,
      });

      return {
        channel: "webex",
        messageId: result.id,
        roomId: result.roomId,
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "webex",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),

    buildChannelSummary: ({ snapshot }) => ({
      configured: (snapshot.configured ?? false) as boolean,
      baseUrl: (snapshot.baseUrl ?? null) as string | null,
      running: (snapshot.running ?? false) as boolean,
      lastStartAt: (snapshot.lastStartAt ?? null) as Date | null,
      lastStopAt: (snapshot.lastStopAt ?? null) as Date | null,
      lastError: (snapshot.lastError ?? null) as string | null,
    }),

    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.configured) {
        return {
          ok: false,
          error: "Account not configured",
          elapsedMs: 0,
        };
      }

      const start = Date.now();
      try {
        const response = await fetch(
          `${account.config.apiBaseUrl ?? "https://webexapis.com/v1"}/people/me`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${account.config.token}`,
              "Content-Type": "application/json",
            },
            signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
          }
        );

        const elapsedMs = Date.now() - start;

        if (!response.ok) {
          return {
            ok: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
            elapsedMs,
          };
        }

        return { ok: true, elapsedMs };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - start,
        };
      }
    },

    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, runtime, log, setStatus, abortSignal } = ctx;

      setStatus({
        accountId: account.accountId,
        baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
      });

      log?.info?.(
        `[${account.accountId}] starting Webex provider (webhook mode)`
      );

      // Initialize webhook handler
      const webhookHandler = new WebexWebhookHandler(account.config);
      await webhookHandler.initialize();

      // Register webhooks with Webex
      try {
        await webhookHandler.registerWebhooks();
        log?.info?.(`[${account.accountId}] webhooks registered`);
      } catch (err) {
        log?.warn?.(
          `[${account.accountId}] failed to register webhooks: ${err instanceof Error ? err.message : err}`
        );
      }

      // Register webhook target for HTTP handler
      const webhookPath = `/webhooks/webex/${account.accountId}`;

      const unregister = registerWebexWebhookTarget(webhookPath, {
        account,
        config: account.config,
        webhookHandler,
      });

      log?.info?.(
        `[${account.accountId}] HTTP webhook handler registered at ${webhookPath}`
      );

      // Webhook delivery is push-based: there's no connection to hold open, but the
      // gateway's account supervisor treats *any* resolution of this promise (even a
      // successful one) as the channel having exited, and auto-restarts it. So we must
      // stay pending until the gateway signals this account is stopping.
      await new Promise<void>((resolve) => {
        if (abortSignal?.aborted) {
          resolve();
          return;
        }
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      log?.info?.(`[${account.accountId}] stopping Webex provider`);
      unregister();
    },
  },
};
