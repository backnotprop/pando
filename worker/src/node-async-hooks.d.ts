// The one Node API the Worker uses (nodejs_compat provides it at runtime).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
