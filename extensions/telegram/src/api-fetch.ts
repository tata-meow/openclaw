export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
}): Promise<string | null> {
  const base = params.apiRoot?.replace(/\/+$/, "") || "https://api.telegram.org";
  const url = `${base}/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  try {
    const res = await fetch(url, params.signal ? { signal: params.signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: number | string };
    } | null;
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  }
}
