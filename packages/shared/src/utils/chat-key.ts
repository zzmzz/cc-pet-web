export function makeChatKey(connectionId: string, sessionKey: string): string {
  return `${connectionId}::${sessionKey}`;
}

export function parseChatKey(chatKey: string): { connectionId: string; sessionKey: string } {
  const idx = chatKey.indexOf("::");
  if (idx === -1) throw new Error(`Invalid chatKey: ${chatKey}`);
  return {
    connectionId: chatKey.slice(0, idx),
    sessionKey: chatKey.slice(idx + 2),
  };
}
