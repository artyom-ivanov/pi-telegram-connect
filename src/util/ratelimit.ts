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

  async consume(): Promise<void> {
    for (;;) {
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
