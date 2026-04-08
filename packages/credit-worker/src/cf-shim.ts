/**
 * Shim for `cloudflare:workers` module when running outside Cloudflare.
 *
 * Provides a minimal DurableObject base class that the engine extends.
 * In standalone mode, CreditAgent.createStandalone() bypasses the constructor
 * entirely, so this class is never actually instantiated.
 */

export class DurableObject<E = unknown> {
  protected env: E;
  protected ctx: { storage: { get: <T>(_k: string) => Promise<T | undefined>; put: (_k: string, _v: unknown) => Promise<void> } };

  constructor(ctx: unknown, env: E) {
    this.env = env;
    this.ctx = ctx as typeof this.ctx;
  }
}
