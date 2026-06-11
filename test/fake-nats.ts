import type { NatsConnectionLike, NatsMsgLike, NatsRequestOptions } from '@wyrd-company/a2a-nats';

export class FakeNatsBroker implements NatsConnectionLike {
  private readonly subscriptions = new Map<string, Set<FakeSubscription>>();
  private inboxCounter = 1;

  createInbox(): string {
    return `_INBOX.${this.inboxCounter++}`;
  }

  publish(subject: string, data?: Uint8Array, options?: { reply?: string }): void {
    for (const subscription of this.subscriptions.get(subject) ?? []) {
      subscription.deliver({
        data: data ?? new Uint8Array(),
        reply: options?.reply,
        respond: response => {
          if (!options?.reply) return false;
          this.publish(options.reply, response);
          return true;
        },
      });
    }
  }

  request(subject: string, data?: Uint8Array, options?: NatsRequestOptions): Promise<NatsMsgLike> {
    const reply = this.createInbox();
    const subscription = this.subscribe(reply);
    this.publish(subject, data, { reply });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error(`No response for ${subject}`));
      }, options?.timeout ?? 1_000);
      void (async () => {
        for await (const message of subscription) {
          clearTimeout(timeout);
          subscription.unsubscribe();
          resolve(message);
          return;
        }
      })();
    });
  }

  subscribe(subject: string): FakeSubscription {
    const subscription = new FakeSubscription(() => {
      this.subscriptions.get(subject)?.delete(subscription);
    });
    const subscriptions = this.subscriptions.get(subject) ?? new Set<FakeSubscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(subject, subscriptions);
    return subscription;
  }

  async flush(): Promise<void> {}
}

class FakeSubscription implements AsyncIterable<NatsMsgLike> {
  private readonly queue: Array<NatsMsgLike | null> = [];
  private waiter: ((message: NatsMsgLike | null) => void) | undefined;
  private closed = false;

  constructor(private readonly onUnsubscribe: () => void) {}

  deliver(message: NatsMsgLike): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    this.onUnsubscribe();
    this.deliverNull();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NatsMsgLike> {
    while (true) {
      const message = await this.next();
      if (message === null) return;
      yield message;
    }
  }

  private next(): Promise<NatsMsgLike | null> {
    const message = this.queue.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }

  private deliverNull(): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(null);
      return;
    }
    this.queue.push(null);
  }
}
