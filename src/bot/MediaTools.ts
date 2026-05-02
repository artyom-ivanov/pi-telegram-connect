import { Type } from "@sinclair/typebox";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatId, ThreadId, ToolErrorCode, ToolResult } from "../types.js";
import { assertInsideRoot, expandHome, openForUpload, truncateCaption } from "../util/paths.js";

interface ToolContext {
  chatId: ChatId;
  threadId: ThreadId;
  outboundAllowedRoots: string[];
  client: {
    sendPhoto(args: any): Promise<{ message_id: number }>;
    sendVoice(args: any): Promise<{ message_id: number }>;
    sendAudio(args: any): Promise<{ message_id: number }>;
    sendVideo(args: any): Promise<{ message_id: number }>;
    sendSticker(args: any): Promise<{ message_id: number }>;
    sendDocument(args: any): Promise<{ message_id: number }>;
  };
}

/** Generic shape compatible with @mariozechner/pi-coding-agent's defineTool */
type ToolDefinition = {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (params: any) => Promise<ToolResult>;
};

async function resolveOutboundPath(raw: string, roots: string[]): Promise<string> {
  let lastErr: unknown = null;
  for (const root of roots) {
    try {
      return await assertInsideRoot(raw, resolve(expandHome(root)), true);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("path_outside_sandbox");
}

async function checkOggMagic(absPath: string): Promise<boolean> {
  const fh = await open(absPath, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return buf.toString("ascii") === "OggS";
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function reply(_ctx: ToolContext, replyTo: number | undefined): { reply_parameters?: { message_id: number } } {
  if (replyTo && replyTo > 0) return { reply_parameters: { message_id: replyTo } };
  return {};
}

function chatArgs(ctx: ToolContext): { chat_id: number; message_thread_id?: number } {
  const out: { chat_id: number; message_thread_id?: number } = { chat_id: ctx.chatId };
  if (ctx.threadId > 0) out.message_thread_id = ctx.threadId;
  return out;
}

const errResult = (code: ToolErrorCode): ToolResult => ({ ok: false, error: code });

function toErr(e: unknown): ToolErrorCode {
  const m = (e as { message?: string } | undefined)?.message ?? "";
  if (m.startsWith("path_outside_sandbox")) return "path_outside_sandbox";
  if (m.startsWith("file_too_large")) return "file_too_large";
  if (m.startsWith("unsupported_type")) return "unsupported_type";
  if (m.startsWith("invalid_format")) return "invalid_format";
  if ((e as { code?: string } | undefined)?.code === "ENOENT") return "file_not_found";
  return "telegram_api_error";
}

const MAX_OUTBOUND_BYTES = 2_000_000_000;

export function buildMediaTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: "telegram_send_photo",
      description: "Send a photo (jpeg/png) to the current Telegram chat. Path must be a local file under the connector sandbox.",
      parameters: Type.Object({
        path: Type.String(),
        caption: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path: string; caption?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
          const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              photo: { source: abs },
              caption: truncateCaption(p.caption),
            };
            const r = await ctx.client.sendPhoto(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            await fh.close().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
    {
      name: "telegram_send_voice",
      description: "Send a voice message (must be Ogg/Opus) to the current chat. Path must be local under sandbox.",
      parameters: Type.Object({
        path: Type.String(),
        caption: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path: string; caption?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
          if (!(await checkOggMagic(abs))) return errResult("invalid_format");
          const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              voice: { source: abs },
              caption: truncateCaption(p.caption),
            };
            const r = await ctx.client.sendVoice(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            await fh.close().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
    {
      name: "telegram_send_audio",
      description: "Send an audio file (mp3/m4a/ogg/flac) to the current chat. Path must be local under sandbox.",
      parameters: Type.Object({
        path: Type.String(),
        caption: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        performer: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path: string; caption?: string; title?: string; performer?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
          const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              audio: { source: abs },
              caption: truncateCaption(p.caption),
              title: p.title,
              performer: p.performer,
            };
            const r = await ctx.client.sendAudio(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            await fh.close().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
    {
      name: "telegram_send_video",
      description: "Send a video (mp4) to the current chat. Path must be local under sandbox.",
      parameters: Type.Object({
        path: Type.String(),
        caption: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path: string; caption?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
          const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              video: { source: abs },
              caption: truncateCaption(p.caption),
            };
            const r = await ctx.client.sendVideo(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            await fh.close().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
    {
      name: "telegram_send_sticker",
      description: "Send a sticker. Pass exactly one of: path (local .webp under sandbox) OR fileId (Telegram file_id).",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        fileId: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path?: string; fileId?: string; emoji?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          if (!p.path && !p.fileId) return errResult("invalid_format");
          if (p.path && p.fileId) return errResult("invalid_format");
          let stickerArg: { source: string } | string;
          let fhClose: (() => Promise<unknown>) | null = null;
          if (p.path) {
            const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
            const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
            stickerArg = { source: abs };
            fhClose = () => fh.close();
          } else {
            stickerArg = p.fileId!;
          }
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              sticker: stickerArg,
              emoji: p.emoji,
            };
            const r = await ctx.client.sendSticker(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            if (fhClose) await fhClose().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
    {
      name: "telegram_send_document",
      description: "Send a generic document (any file type). Path must be local under sandbox.",
      parameters: Type.Object({
        path: Type.String(),
        caption: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.Number()),
      }),
      async execute(p: { path: string; caption?: string; replyTo?: number }): Promise<ToolResult> {
        try {
          const abs = await resolveOutboundPath(p.path, ctx.outboundAllowedRoots);
          const { fh } = await openForUpload(abs, MAX_OUTBOUND_BYTES);
          try {
            const args = {
              ...chatArgs(ctx),
              ...reply(ctx, p.replyTo),
              document: { source: abs },
              caption: truncateCaption(p.caption),
            };
            const r = await ctx.client.sendDocument(args);
            return { ok: true, messageId: r.message_id };
          } finally {
            await fh.close().catch(() => undefined);
          }
        } catch (e) {
          return errResult(toErr(e));
        }
      },
    },
  ];
}
