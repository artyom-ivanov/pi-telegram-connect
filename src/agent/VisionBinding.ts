import type { VisionFn } from "../bot/StickerCache.js";

/**
 * Adapter from pi-ai's completeSimple (or equivalent) to our VisionFn signature.
 * We declare the SDK loosely so the runtime binding can plug actual exports in.
 */
export interface VisionSdkBindings {
  /** Picks a vision-capable model from ModelRegistry. Returns null if none available. */
  pickVisionModel(): Promise<{ model: unknown; apiKey: string; headers?: Record<string, string> } | null>;
  /** completeSimple from @mariozechner/pi-ai with image content support. */
  completeSimple(
    model: unknown,
    messages: Array<{
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    }>,
    opts: { apiKey: string; headers?: Record<string, string> },
  ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export function buildVisionFn(b: VisionSdkBindings): VisionFn {
  return async (req) => {
    const picked = await b.pickVisionModel();
    if (!picked) return null;
    const opts: { apiKey: string; headers?: Record<string, string> } = { apiKey: picked.apiKey };
    if (picked.headers) opts.headers = picked.headers;
    const res = await b.completeSimple(
      picked.model,
      [
        {
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            { type: "image", data: req.imageBase64, mimeType: req.mimeType },
          ],
        },
      ],
      opts,
    );
    const text = res.content.find((c) => c.type === "text")?.text?.trim();
    if (!text) return null;
    return { description: text.replace(/\s+/g, " ").slice(0, 200) };
  };
}
