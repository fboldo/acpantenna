/** The parts of the Bot API's types the channel reads. */

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	is_forum?: boolean;
}

export interface TelegramMessageEntity {
	type: string;
	offset: number;
	length: number;
	user?: TelegramUser;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	is_topic_message?: boolean;
	from?: TelegramUser;
	sender_chat?: TelegramChat;
	date: number;
	chat: TelegramChat;
	text?: string;
	caption?: string;
	entities?: TelegramMessageEntity[];
	caption_entities?: TelegramMessageEntity[];
	reply_to_message?: TelegramMessage;
	photo?: unknown[];
	document?: unknown;
	voice?: unknown;
	video?: unknown;
	audio?: unknown;
	sticker?: unknown;
	migrate_to_chat_id?: number;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}
