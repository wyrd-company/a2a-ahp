export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export class AsyncTopic<T> {
  private readonly subscribers = new Set<AsyncQueue<T>>();

  subscribe(): AsyncIterableIterator<T> {
    const queue = new AsyncQueue<T>();
    this.subscribers.add(queue);
    const originalReturn = queue.return.bind(queue);
    queue.return = async () => {
      this.subscribers.delete(queue);
      return originalReturn();
    };
    return queue;
  }

  publish(value: T): void {
    for (const subscriber of this.subscribers) subscriber.push(value);
  }

  close(): void {
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}
