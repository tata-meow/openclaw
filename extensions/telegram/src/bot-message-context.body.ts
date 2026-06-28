// Telegram plugin module implements bot message context.body behavior.
import {
  buildMentionRegexes,
  formatLocationText,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  type BuildChannelInboundEventContextParams,
  type BuildMentionRegexesOptions,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderLabel,
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  renderTelegramTextEntities,
  resolveTelegramPrimaryMedia,
  TELEGRAM_RICH_MESSAGE_PLACEHOLDER,
} from "./bot/body-helpers.js";
import { buildTelegramGroupPeerId, buildTelegramInboundOriginTarget } from "./bot/helpers.js";
import { renderRichCommandText, renderRichMessageToText } from "./bot/rich-render.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";

type StickerVisionRuntime = typeof import("./sticker-vision.runtime.js");
type MediaUnderstandingRuntime = typeof import("./media-understanding.runtime.js");
type TelegramMentionFacts = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;

let stickerVisionRuntimePromise: Promise<StickerVisionRuntime> | undefined;
let mediaUnderstandingRuntimePromise: Promise<MediaUnderstandingRuntime> | undefined;

function loadStickerVisionRuntime(): Promise<StickerVisionRuntime> {
  stickerVisionRuntimePromise ??= import("./sticker-vision.runtime.js");
  return stickerVisionRuntimePromise;
}

function loadMediaUnderstandingRuntime(): Promise<MediaUnderstandingRuntime> {
  mediaUnderstandingRuntimePromise ??= import("./media-understanding.runtime.js");
  return mediaUnderstandingRuntimePromise;
}

export type TelegramInboundBodyResult = {
  bodyText: string;
  rawBody: string;
  historyKey?: string;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  mentionFacts: TelegramMentionFacts;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  hasControlCommand: boolean;
  audioTranscribedMediaIndex?: number;
  stickerCacheHit: boolean;
  locationData?: NormalizedLocation;
};

function formatAudioTranscriptForAgent(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

type TelegramSavedMediaKind = "audio" | "document" | "image" | "video";

function resolveSavedMediaKind(contentType: string | undefined): TelegramSavedMediaKind {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized?.startsWith("audio/")) {
    return "audio";
  }
  if (normalized?.startsWith("image/")) {
    return "image";
  }
  if (normalized?.startsWith("video/")) {
    return "video";
  }
  return "document";
}

function formatSavedMediaPlaceholder(allMedia: TelegramMediaRef[]): string | undefined {
  if (allMedia.length === 0) {
    return undefined;
  }
  const kinds = allMedia.map((media) => resolveSavedMediaKind(media.contentType));
  const firstKind = kinds[0] ?? "document";
  const kind = kinds.every((candidate) => candidate === firstKind) ? firstKind : "document";
  if (allMedia.length === 1) {
    return `<media:${kind}>`;
  }
  if (kind === "image") {
    return `<media:image> (${allMedia.length} images)`;
  }
  if (kind === "video") {
    return `<media:video> (${allMedia.length} videos)`;
  }
  if (kind === "audio") {
    return `<media:audio> (${allMedia.length} audio attachments)`;
  }
  return `<media:document> (${allMedia.length} attachments)`;
}

function resolveTelegramMentionFacts(params: {
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  explicitlyMentionedBot: boolean;
  computedWasMentioned: boolean;
  implicitMentionKinds: TelegramMentionFacts["implicitMentionKinds"];
  requireMention: boolean;
  shouldBypassMention: boolean;
  shouldSkip: boolean;
}): TelegramMentionFacts {
  let mentionSource: TelegramMentionFacts["mentionSource"];
  if (params.explicitlyMentionedBot) {
    mentionSource = "explicit_bot";
  } else if (params.computedWasMentioned) {
    mentionSource = "mention_pattern";
  } else if (params.implicitMentionKinds && params.implicitMentionKinds.length > 0) {
    mentionSource = "implicit_thread";
  } else if (params.shouldBypassMention) {
    mentionSource = "command_bypass";
  }

  return {
    canDetectMention: params.canDetectMention,
    wasMentioned: params.effectiveWasMentioned,
    explicitlyMentionedBot: params.explicitlyMentionedBot,
    mentionSource,
    implicitMentionKinds: params.implicitMentionKinds,
    effectiveWasMentioned: params.effectiveWasMentioned,
    requireMention: params.requireMention,
    shouldSkip: params.shouldSkip,
  };
}

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
    return await resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}

export async function resolveTelegramInboundBody(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  isGroup: boolean;
  chatId: number | string;
  accountId?: string;
  senderId: string;
  senderUsername: string;
  sessionKey?: string;
  resolvedThreadId?: number;
  replyThreadId?: number;
  originatingTo?: string;
  routeAgentId?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  providerMentionPatterns?: BuildMentionRegexesOptions["providerPolicy"];
  requireMention?: boolean;
  options?: TelegramMessageContextOptions;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  logger: TelegramLogger;
}): Promise<TelegramInboundBodyResult | null> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    accountId,
    senderId,
    senderUsername,
    sessionKey,
    resolvedThreadId,
    replyThreadId,
    originatingTo: providedOriginatingTo,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    providerMentionPatterns,
    requireMention,
    options,
    groupHistories,
    historyLimit,
    logger,
  } = params;
  const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
  const mentionRegexes = buildMentionRegexes(cfg, routeAgentId, {
    provider: "telegram",
    conversationId: isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId),
    providerPolicy: providerMentionPatterns,
  });
  const messageTextParts = getTelegramTextParts(msg);
  // Inbound rich_message is flattened here — the only place that needs the rich body —
  // so getTelegramTextParts stays cheap/text-only for the many hot callers (debounce, gates).
  let richMarkdown = "";
  let richPlain = "";
  if (msg.rich_message) {
    const flatPlain = renderRichMessageToText(msg.rich_message, "plain");
    // Plain strips structure-only blocks (a lone divider -> ""); empty plain means no real
    // content, so the message stays empty and drops at the body guard below as before.
    if (flatPlain && !isBinaryContent(flatPlain)) {
      richPlain = flatPlain;
      const md = renderRichMessageToText(msg.rich_message, "markdown");
      // markdown also emits url/mailto/tel targets plain omits; if those drag in control
      // chars, fall back to the already-clean plain text rather than dropping a real message.
      richMarkdown = isBinaryContent(md) ? richPlain : md;
    }
  }
  // gatingText folds full rich plain text into mention gating so rich-only messages can
  // address the bot anywhere in their blocks like text/caption does.
  const gatingText = [messageTextParts.text, richPlain].filter(Boolean).join("\n");
  // Command gating is stricter: only prose blocks count, so a code/quote block beginning
  // with "/cmd" is not misread as a typed control command.
  const richCommandText = msg.rich_message ? renderRichCommandText(msg.rich_message) : "";
  const commandText = [messageTextParts.text, richCommandText].filter(Boolean).join("\n");
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(commandText, cfg, {
    botUsername,
  });
  const commandGate = await resolveTelegramCommandIngressAuthorization({
    accountId: accountId ?? "default",
    cfg,
    dmPolicy: "pairing",
    isGroup,
    chatId,
    resolvedThreadId,
    senderId,
    effectiveDmAllow,
    effectiveGroupAllow,
    ownerAccess: { ownerList: [], senderIsOwner: false },
    eventKind: "message",
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    modeWhenAccessGroupsOff: "allow",
    includeDmAllowForGroupCommands: false,
  });
  const commandAuthorized = commandGate.authorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;
  const originatingTo = providedOriginatingTo ?? buildTelegramInboundOriginTarget(chatId);

  const primaryMedia = resolveTelegramPrimaryMedia(msg);
  let placeholder = primaryMedia?.placeholder ?? "";
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision = msg.sticker
    ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const baseRendered = renderTelegramTextEntities(
    messageTextParts.text,
    messageTextParts.entities,
  ).trim();
  // Append flattened rich markdown after the base text/caption so rich-only
  // messages produce body text and no longer drop at the empty-body guard below.
  const rawText = [baseRendered, richMarkdown].filter(Boolean).join("\n").trim();
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    // A rich_message that flattened to nothing readable still must not vanish: fall back to
    // the marker so it surfaces instead of dropping at the empty-body guard below.
    rawBody = placeholder || (msg.rich_message ? TELEGRAM_RICH_MESSAGE_PLACEHOLDER : "");
  }
  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  if (stickerCacheHit && placeholder && rawBody !== placeholder) {
    bodyText = `${placeholder}\n${bodyText}`.trim();
  }
  if (allMedia.length === 0 && placeholder && rawBody !== placeholder) {
    const mediaTag = primaryMedia?.fileRef.file_id
      ? `${placeholder} [file_id:${primaryMedia.fileRef.file_id}]`
      : placeholder;
    bodyText = `${mediaTag}\n${bodyText}`.trim();
  }
  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight =
    !useAccessGroups || !allowForCommands.hasEntries || commandAuthorized;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    hasAudio &&
    !hasUserText &&
    (!isGroup ||
      (requireMention &&
        mentionRegexes.length > 0 &&
        !disableAudioPreflight &&
        senderAllowedForAudioPreflight));

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
      const tempCtx: MsgContext = {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: originatingTo,
        AccountId: accountId,
        MessageThreadId: replyThreadId,
        MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
            : undefined,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }
  const audioTranscribedMediaIndex =
    preflightTranscript === undefined
      ? undefined
      : allMedia.findIndex((media) => media.contentType?.startsWith("audio/"));

  if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) {
    bodyText = formatAudioTranscriptForAgent(preflightTranscript);
  }

  const savedMediaPlaceholder = formatSavedMediaPlaceholder(allMedia);
  if (
    !stickerCacheHit &&
    !hasAudio &&
    savedMediaPlaceholder &&
    placeholder &&
    bodyText === placeholder
  ) {
    bodyText = savedMediaPlaceholder;
  }
  if (!bodyText && allMedia.length > 0) {
    if (hasAudio) {
      bodyText = preflightTranscript
        ? formatAudioTranscriptForAgent(preflightTranscript)
        : "<media:audio>";
    } else {
      bodyText = savedMediaPlaceholder ?? "<media:document>";
    }
  }

  const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername, richPlain) : false;
  const computedWasMentioned = matchesMentionWithExplicit({
    text: gatingText,
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;

  if (isGroup && commandGate.shouldBlockControlCommand) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }

  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const replyToBotMessage = botId != null && replyFromId === botId;
  const isReplyToServiceMessage =
    replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    replyToBotMessage && !isReplyToServiceMessage,
  );
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds: isGroup ? implicitMentionKinds : [],
    },
    policy: {
      isGroup,
      requireMention: Boolean(requireMention),
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    logger.info({ chatId, reason: "no-mention" }, "skipping group message");
    createChannelHistoryWindow({ historyMap: groupHistories }).record({
      historyKey: historyKey ?? "",
      limit: historyLimit,
      entry: historyKey
        ? {
            sender: buildSenderLabel(msg, senderId || chatId),
            body: rawBody,
            timestamp: msg.date ? msg.date * 1000 : undefined,
            messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
          }
        : null,
    });
    const telegramGroupPolicy = resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      groupId: String(chatId),
      accountId,
    });
    const ingestEnabled =
      topicConfig?.ingest ??
      telegramGroupPolicy.groupConfig?.ingest ??
      telegramGroupPolicy.defaultConfig?.ingest;
    if (ingestEnabled === true && sessionKey) {
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent(
            "message",
            "received",
            sessionKey,
            toInternalMessageReceivedContext({
              from: `telegram:group:${historyKey ?? chatId}`,
              to: originatingTo,
              content: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              channelId: "telegram",
              accountId,
              conversationId: originatingTo,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
              senderId: senderId || undefined,
              senderName: buildSenderName(msg),
              senderUsername: senderUsername || undefined,
              provider: "telegram",
              surface: "telegram",
              threadId: resolvedThreadId,
              originatingChannel: "telegram",
              originatingTo,
              isGroup: true,
              groupId: `telegram:${chatId}`,
            }),
          ),
        ),
        "telegram: mention-skip message hook failed",
      );
    }
    return null;
  }

  return {
    bodyText,
    rawBody,
    historyKey,
    commandAuthorized,
    effectiveWasMentioned,
    mentionFacts: resolveTelegramMentionFacts({
      canDetectMention,
      effectiveWasMentioned,
      explicitlyMentionedBot: explicitlyMentioned,
      computedWasMentioned,
      implicitMentionKinds,
      requireMention: Boolean(requireMention),
      shouldBypassMention: mentionDecision.shouldBypassMention,
      shouldSkip: mentionDecision.shouldSkip,
    }),
    canDetectMention,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    hasControlCommand: hasControlCommandInMessage,
    ...(audioTranscribedMediaIndex !== undefined && audioTranscribedMediaIndex >= 0
      ? { audioTranscribedMediaIndex }
      : {}),
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
