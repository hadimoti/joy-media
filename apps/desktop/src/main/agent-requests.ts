/**
 * The provider calls the renderer started and has not finished, by the id the renderer gave each one. A
 * call ends when the renderer cancels it, or when the page that started it goes away. A call that finishes
 * removes only itself, so an older call cannot take a newer one's place.
 */
export class AgentRequestRegistry {
  readonly #calls = new Map<string, AbortController>();

  /** Starts a call under its id. Returns undefined when that id is already in use: it is not shared. */
  begin(requestId: string): AbortController | undefined {
    if (this.#calls.has(requestId)) return undefined;
    const controller = new AbortController();
    this.#calls.set(requestId, controller);
    return controller;
  }

  /** Forgets a finished call, but only when it is still the one started under this controller. */
  finish(requestId: string, controller: AbortController): void {
    if (this.#calls.get(requestId) === controller) this.#calls.delete(requestId);
  }

  /** Ends the named call. Returns false when no such call is in progress. */
  cancel(requestId: string): boolean {
    const controller = this.#calls.get(requestId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** Ends every call in progress, when the page that started them has reloaded or gone. */
  cancelAll(): void {
    for (const controller of this.#calls.values()) controller.abort();
    this.#calls.clear();
  }
}
