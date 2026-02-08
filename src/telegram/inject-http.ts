import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message, Update, UserFromGetMe } from "@grammyjs/types";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBot } from "./bot.js";
import { getBearerToken } from "../gateway/http-utils.js";

type TelegramInjectPayload = {
  update: Update;
  accountId?: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve({ ok: true, value: parsed });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

function isValidUpdate(value: unknown): value is Update {
  if (!value || typeof value !== "object") {
    return false;
  }
  const update = value as Partial<Update>;
  return typeof update.update_id === "number";
}

function getTelegramInjectConfig(cfg: OpenClawConfig, accountId: string) {
  const account = resolveTelegramAccount({ cfg, accountId });
  const inject = account.config.inject;
  if (!inject?.enabled) {
    return null;
  }
  const token = inject.token?.trim();
  if (!token) {
    throw new Error(`telegram.accounts.${accountId}.inject.enabled requires inject.token`);
  }
  return {
    token,
    accountId: account.accountId,
    botToken: account.token,
    config: account.config,
  };
}

export async function handleTelegramInjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/telegram/inject") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const cfg = loadConfig();
  const requestedAccountId = url.searchParams.get("accountId") || undefined;

  // Find enabled inject config
  let injectConfig: ReturnType<typeof getTelegramInjectConfig> = null;
  if (requestedAccountId) {
    try {
      injectConfig = getTelegramInjectConfig(cfg, requestedAccountId);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
      return true;
    }
  } else {
    // Try default account first (single-account mode)
    try {
      injectConfig = getTelegramInjectConfig(cfg, undefined);
    } catch {
      // If default fails, try multi-account mode
      const accounts = cfg.channels?.telegram?.accounts ?? {};
      for (const [accountId] of Object.entries(accounts)) {
        try {
          const config = getTelegramInjectConfig(cfg, accountId);
          if (config) {
            injectConfig = config;
            break;
          }
        } catch {
          // Skip invalid configs
        }
      }
    }
  }

  if (!injectConfig) {
    sendJson(res, 503, {
      ok: false,
      error: "telegram inject not enabled (set channels.telegram.accounts.<id>.inject.enabled)",
    });
    return true;
  }

  // Verify token
  const token = getBearerToken(req);
  if (!token || token !== injectConfig.token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized");
    return true;
  }

  // Read and parse body
  const body = await readJsonBody(req, 1024 * 1024); // 1MB max
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { ok: false, error: body.error });
    return true;
  }

  const payload =
    typeof body.value === "object" && body.value !== null
      ? (body.value as Record<string, unknown>)
      : {};

  // Validate payload
  if (!payload.update || typeof payload.update !== "object") {
    sendJson(res, 400, { ok: false, error: "update required" });
    return true;
  }

  if (!isValidUpdate(payload.update)) {
    sendJson(res, 400, { ok: false, error: "invalid update format" });
    return true;
  }

  const update = payload.update;

  // Extract message from update
  const message =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post;

  if (!message) {
    sendJson(res, 400, { ok: false, error: "no message in update" });
    return true;
  }

  try {
    // Create bot instance with all handlers registered
    // This reuses the full bot setup including message processing
    const bot = createTelegramBot({
      token: injectConfig.botToken,
      accountId: injectConfig.accountId,
      config: cfg,
      runtime: {
        log: console.log,
        error: console.error,
        exit: () => {
          throw new Error("exit not supported in inject mode");
        },
      },
    });

    // Initialize bot to fetch bot info (required for mention detection, etc.)
    await bot.init();

    // Manually trigger the bot's update handling
    // This will run through all registered middlewares and handlers
    // just like a normal polling update would
    await bot.handleUpdate(update);

    sendJson(res, 202, {
      ok: true,
      message: "update processed",
      updateId: update.update_id,
    });
    return true;
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
    return true;
  }
}
