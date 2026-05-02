/** Simple token bucket: refills `ratePerSec` tokens per second, capped at `burst`. */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.lastRefill = now;
  }

  /** Wait until a token is available, then consume it. */
  async consume(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const need = 1 - this.tokens;
      const waitMs = Math.ceil((need / this.ratePerSec) * 1000) + 5;
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
}

/** Per-chat (1/sec each, burst 3) + global (25/sec, burst 30) combined limiter. */
export class TelegramRateLimiter {
  private global = new TokenBucket(25, 30);
  private perChat = new Map<number, TokenBucket>();

  async wait(chatId: number): Promise<void> {
    let bucket = this.perChat.get(chatId);
    if (!bucket) {
      bucket = new TokenBucket(1, 3);
      this.perChat.set(chatId, bucket);
    }
    await Promise.all([this.global.consume(), bucket.consume()]);
  }
}
