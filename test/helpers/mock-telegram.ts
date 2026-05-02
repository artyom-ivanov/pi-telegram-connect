export interface TelegramCall {
  method: string;
  args: Record<string, unknown>;
}

export class MockTelegramClient {
  calls: TelegramCall[] = [];
  private handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

  on(method: string, handler: (args: Record<string, unknown>) => unknown): void {
    this.handlers[method] = handler;
  }

  async sendMessage(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendMessage", args });
    const h = this.handlers.sendMessage;
    if (h) return h(args) as { message_id: number };
    return { message_id: this.calls.length };
  }

  async editMessageText(args: Record<string, unknown>): Promise<true> {
    this.calls.push({ method: "editMessageText", args });
    const h = this.handlers.editMessageText;
    if (h) return h(args) as true;
    return true;
  }

  async sendPhoto(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendPhoto", args });
    return { message_id: this.calls.length };
  }
  async sendVoice(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendVoice", args });
    return { message_id: this.calls.length };
  }
  async sendAudio(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendAudio", args });
    return { message_id: this.calls.length };
  }
  async sendVideo(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendVideo", args });
    return { message_id: this.calls.length };
  }
  async sendSticker(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendSticker", args });
    return { message_id: this.calls.length };
  }
  async sendDocument(args: Record<string, unknown>): Promise<{ message_id: number }> {
    this.calls.push({ method: "sendDocument", args });
    return { message_id: this.calls.length };
  }
}
