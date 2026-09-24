/** Keeps replaced export links alive while a browser download can still claim them. */
export function createExportUrlRetention(
  getCurrentUrl: () => string | null,
  retentionMs: number,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(url: string): void {
      const existing = timers.get(url);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(url);
        if (getCurrentUrl() !== url) revoke(url);
      }, retentionMs);
      timers.set(url, timer);
    },

    dispose(): void {
      const urls = new Set(timers.keys());
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      const currentUrl = getCurrentUrl();
      if (currentUrl !== null) urls.add(currentUrl);
      for (const url of urls) revoke(url);
    },
  };
}
