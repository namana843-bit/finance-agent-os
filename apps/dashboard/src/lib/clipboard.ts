import { useState, useCallback } from "react";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useClipboard(timeout = 1500) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), timeout);
    }
    return ok;
  }, [timeout]);
  return { copied, copy };
}
