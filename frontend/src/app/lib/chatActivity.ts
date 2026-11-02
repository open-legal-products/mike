export type ChatActivity = {
    id: string;
    created_at?: string | null;
    updated_at?: string | null;
};

export function chatActivityAt(chat: ChatActivity): string | undefined {
    return chat.updated_at || chat.created_at || undefined;
}

export function sortChatsByActivity<T extends ChatActivity>(chats: T[]): T[] {
    return [...chats].sort((a, b) => {
        const difference =
            (Date.parse(chatActivityAt(b) ?? "") || 0) -
            (Date.parse(chatActivityAt(a) ?? "") || 0);
        return difference || a.id.localeCompare(b.id);
    });
}

export function touchChatActivity<T extends ChatActivity>(
    chats: T[],
    chatId: string,
    updatedAt = new Date().toISOString(),
): T[] {
    if (!chats.some((chat) => chat.id === chatId)) return chats;
    return sortChatsByActivity(
        chats.map((chat) =>
            chat.id === chatId ? { ...chat, updated_at: updatedAt } : chat,
        ),
    );
}
