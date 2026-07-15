/**
 * OpenClaw Plugin SDK Type Declarations
 *
 * These are minimal type stubs for the OpenClaw plugin SDK.
 * They provide enough type information to compile the plugin.
 */

declare module "openclaw/plugin-sdk" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  /** Plugin-owned HTTP route handler; return true once the response has been written. */
  export type OpenClawPluginHttpRouteHandler = (
    req: IncomingMessage,
    res: ServerResponse
  ) => Promise<boolean | void> | boolean | void;

  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    /** "gateway" requires OpenClaw's own gateway auth; "plugin" means the handler authenticates itself. */
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }

  /** Plugin API provided to plugins during registration */
  export interface OpenClawPluginApi {
    registerChannel(opts: { plugin: ChannelPlugin<unknown> }): void;
    registerGatewayMethod(name: string, handler: unknown): void;
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerCli(callback: unknown, opts?: { commands: string[] }): void;
    registerService(service: unknown): void;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };
    config: unknown;
    runtime: PluginRuntime;
  }

  /** Runtime helpers available to plugins */
  export interface PluginRuntime {
    http: {
      registerHandler(opts: {
        method: string;
        path: string;
        handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
      }): void;
      unregisterHandler(path: string): void;
    };
    messaging: {
      handleInbound(envelope: InboundMessage): Promise<void>;
    };
    channel: {
      text: {
        chunkMarkdownText(text: string, limit: number): string[];
      };
    };
    tts: {
      textToSpeechTelephony(opts: { text: string; cfg: unknown }): Promise<unknown>;
    };
  }

  export interface HttpRequest {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | string[] | undefined>;
  }

  export interface HttpResponse {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }

  export interface InboundMessage {
    channel: string;
    accountId: string;
    senderId: string;
    senderEmail?: string;
    conversationId: string;
    messageId: string;
    text: string;
    roomType?: string;
    threadId?: string;
    timestamp?: Date;
    raw?: unknown;
  }

  /** Channel plugin interface */
  export interface ChannelPlugin<TAccount> {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[] };
    configSchema?: unknown;
    onboarding?: unknown;
    pairing?: unknown;
    config: ChannelConfigAdapter<TAccount>;
    security?: ChannelSecurityAdapter<TAccount>;
    groups?: unknown;
    threading?: ChannelThreadingAdapter;
    messaging?: ChannelMessagingAdapter;
    directory?: unknown;
    resolver?: unknown;
    actions?: unknown;
    setup?: unknown;
    outbound: ChannelOutboundAdapter<TAccount>;
    status?: ChannelStatusAdapter<TAccount>;
    gateway?: ChannelGatewayAdapter<TAccount>;
  }

  export interface ChannelMeta {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    order?: number;
    aliases?: string[];
    quickstartAllowFrom?: boolean;
    preferOver?: string[];
    detailLabel?: string;
    systemImage?: string;
  }

  export interface ChannelCapabilities {
    chatTypes: ("direct" | "group" | "thread")[];
    threads?: boolean;
    media?: boolean;
    polls?: boolean;
    reactions?: boolean;
  }

  export interface ChannelConfigAdapter<TAccount> {
    listAccountIds(cfg: unknown): string[];
    resolveAccount(cfg: unknown, accountId?: string): TAccount;
    defaultAccountId?(cfg: unknown): string;
    setAccountEnabled?(opts: {
      cfg: unknown;
      accountId: string;
      enabled: boolean;
    }): unknown;
    deleteAccount?(opts: { cfg: unknown; accountId: string }): unknown;
    isConfigured?(account: TAccount): boolean;
    describeAccount?(account: TAccount): {
      accountId: string;
      name?: string;
      enabled: boolean;
      configured: boolean;
      baseUrl?: string;
    };
    resolveAllowFrom?(opts: { cfg: unknown }): string[];
    formatAllowFrom?(opts: { allowFrom: string[] }): string[];
  }

  export interface ChannelSecurityAdapter<TAccount> {
    resolveDmPolicy?(opts: { account: TAccount }): {
      policy: "allow" | "deny" | "allowlist" | "pairing";
      allowFrom: string[];
      policyPath: string;
      allowFromPath: string;
      approveHint?: string;
      normalizeEntry?: (raw: string) => string;
    };
    collectWarnings?(opts: { account: TAccount; cfg: unknown }): string[];
  }

  export interface ChannelThreadingAdapter {
    resolveReplyToMode?(opts: { cfg: unknown }): string;
    buildToolContext?(opts: {
      context: { To?: string; MessageThreadId?: string | number; ReplyToId?: string };
      hasRepliedRef: boolean;
    }): {
      currentChannelId?: string;
      currentThreadTs?: string;
      hasRepliedRef: boolean;
    };
  }

  export interface ChannelMessagingAdapter {
    normalizeTarget?(raw: string): string | undefined;
    targetResolver?: {
      looksLikeId(raw: string): boolean;
      hint: string;
    };
  }

  export interface ChannelOutboundAdapter<TAccount = unknown> {
    deliveryMode: "direct" | "queued";
    chunker?(text: string, limit: number): string[];
    chunkerMode?: "markdown" | "text";
    textChunkLimit?: number;
    sendText(opts: {
      to: string;
      text: string;
      account: TAccount;
      deps?: unknown;
      replyToId?: string;
      threadId?: string | number;
    }): Promise<{
      channel: string;
      messageId?: string;
      roomId?: string;
    }>;
    sendMedia?(opts: {
      to: string;
      text?: string;
      mediaUrl?: string;
      account: TAccount;
      deps?: unknown;
      replyToId?: string;
      threadId?: string | number;
    }): Promise<{
      channel: string;
      messageId?: string;
      roomId?: string;
    }>;
    sendPoll?(opts: {
      to: string;
      poll: unknown;
      threadId?: string | number;
    }): Promise<{
      channel: string;
      messageId?: string;
      roomId?: string;
      pollId?: string;
    }>;
  }

  export interface ChannelStatusAdapter<TAccount> {
    defaultRuntime: {
      accountId: string;
      running: boolean;
      lastStartAt: Date | null;
      lastStopAt: Date | null;
      lastError: string | null;
    };
    collectStatusIssues?(
      accounts: Array<{
        accountId: string;
        running?: boolean;
        lastError?: string | null;
      }>
    ): Array<{
      channel: string;
      accountId: string;
      kind: "runtime" | "config";
      message: string;
    }>;
    buildChannelSummary?(opts: { snapshot: Record<string, unknown> }): {
      configured: boolean;
      baseUrl: string | null;
      running: boolean;
      lastStartAt: Date | null;
      lastStopAt: Date | null;
      lastError: string | null;
      probe?: unknown;
      lastProbeAt?: Date | null;
    };
    probeAccount?(opts: {
      account: TAccount;
      timeoutMs?: number;
      cfg?: unknown;
    }): Promise<{
      ok: boolean;
      error?: string;
      elapsedMs: number;
    }>;
    buildAccountSnapshot?(opts: {
      account: TAccount;
      runtime?: {
        running?: boolean;
        lastStartAt?: Date | null;
        lastStopAt?: Date | null;
        lastError?: string | null;
        lastProbeAt?: Date | null;
        lastInboundAt?: Date | null;
        lastOutboundAt?: Date | null;
      };
      probe?: unknown;
    }): Record<string, unknown>;
  }

  export interface ChannelGatewayAdapter<TAccount> {
    startAccount?(ctx: {
      account: TAccount;
      runtime: PluginRuntime;
      abortSignal?: AbortSignal;
      log?: {
        info?(msg: string): void;
        warn?(msg: string): void;
        error?(msg: string): void;
        debug?(msg: string): void;
      };
      setStatus(status: { accountId: string; baseUrl?: string }): void;
    }): Promise<(() => Promise<void>) | void>;
    stopAccount?(ctx: { account: TAccount }): Promise<void>;
  }

  /** Returns an empty plugin config schema */
  export function emptyPluginConfigSchema(): {
    type: "object";
    additionalProperties: false;
    properties: Record<string, never>;
  };

  /** Build a channel config schema */
  export function buildChannelConfigSchema(schema: unknown): unknown;

  /** Default account ID constant */
  export const DEFAULT_ACCOUNT_ID: string;

  /** Normalize account ID */
  export function normalizeAccountId(accountId?: string): string;

  /** Apply account name to channel section */
  export function applyAccountNameToChannelSection(opts: {
    cfg: unknown;
    channelKey: string;
    accountId: string;
    name?: string;
  }): unknown;

  /** Set account enabled in config section */
  export function setAccountEnabledInConfigSection(opts: {
    cfg: unknown;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): unknown;

  /** Delete account from config section */
  export function deleteAccountFromConfigSection(opts: {
    cfg: unknown;
    sectionKey: string;
    accountId: string;
    clearBaseFields?: string[];
  }): unknown;

  /** Format pairing approve hint */
  export function formatPairingApproveHint(channel: string): string;

  /** Pairing approved message constant */
  export const PAIRING_APPROVED_MESSAGE: string;
}
