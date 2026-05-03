import { marked } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mdToHtml(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  return html
    .replace(/<\/?h[1-6][^>]*>/gi, "")
    .replace(/<\/?ul[^>]*>/gi, "")
    .replace(/<\/?ol[^>]*>/gi, "")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    // BUG GUARD: `/<\/?p[^>]*>/` would also match `<pre>` / `</pre>` (greedy `[^>]*` consumes "re"),
    // breaking every fenced code block (Telegram needs <pre><code class="lang-x"> intact).
    // Anchor strictly: closing `>` immediately or with whitespace+attrs after `p`.
    .replace(/<\/?p(?=[\s>])[^>]*>/gi, "")
    .replace(/<hr[^>]*>/gi, "\n———\n")
    .replace(/<br\s*\/?>(?:\n)?/gi, "\n")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, "$1")
    .replace(/<strong>/gi, "<b>")
    .replace(/<\/strong>/gi, "</b>")
    .replace(/<em>/gi, "<i>")
    .replace(/<\/em>/gi, "</i>")
    .replace(/<del>/gi, "<s>")
    .replace(/<\/del>/gi, "</s>")
    .trim();
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export { escapeHtml };
