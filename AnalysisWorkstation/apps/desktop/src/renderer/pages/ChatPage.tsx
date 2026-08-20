import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ChatCircleText,
  File,
  FileAudio,
  FileImage,
  FileVideo,
  MagnifyingGlass,
  Star,
  WarningCircle,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type {
  AttachmentView,
  CaseSummary,
  ChatSummary,
  EvidenceSource,
  MessageView,
} from "@wafc/domain";

import { EmptyState, InlineError, LoadingRows } from "../components/Feedback";
import {
  errorMessage,
  formatBytes,
  formatCompactDate,
  formatCount,
  unwrap,
} from "../lib/api";

export function ChatPage({ activeCase }: { activeCase: CaseSummary }): React.JSX.Element {
  const [sources, setSources] = useState<EvidenceSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageViewportRef = useRef<HTMLDivElement>(null);
  const initialScrollPending = useRef(false);
  const prependedCount = useRef<number | null>(null);

  const selectedSource = sources.find((item) => item.sourceId === selectedSourceId) ?? null;
  const selectedChat = chats.find((item) => item.nativeId === selectedChatId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoadingSources(true);
    setError(null);
    void window.workstation.repository.sources(activeCase.caseId).then((result) => {
      if (cancelled) return;
      try {
        const loaded = unwrap(result);
        setSources(loaded);
        setSelectedSourceId(loaded[0]?.sourceId ?? null);
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        setLoadingSources(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeCase.caseId]);

  const loadChats = useCallback(async (
    sourceId: string,
    cursor: string | null,
    append: boolean,
  ): Promise<void> => {
    setLoadingChats(true);
    setError(null);
    try {
      const page = unwrap(await window.workstation.repository.chats(activeCase.caseId, {
        sourceId,
        search: chatSearch,
        cursor,
        limit: 80,
      }));
      setChats((current) => append ? [...current, ...page.items] : page.items);
      setChatCursor(page.nextCursor);
      if (!append) setSelectedChatId(page.items[0]?.nativeId ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError));
      if (!append) {
        setChats([]);
        setSelectedChatId(null);
      }
    } finally {
      setLoadingChats(false);
    }
  }, [activeCase.caseId, chatSearch]);

  useEffect(() => {
    setChats([]);
    setSelectedChatId(null);
    setMessages([]);
    setMessageCursor(null);
    if (selectedSourceId === null) return;
    const timeout = window.setTimeout(() => {
      void loadChats(selectedSourceId, null, false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [selectedSourceId, loadChats]);

  const loadMessages = useCallback(async (
    sourceId: string,
    chatId: string,
    beforeCursor: string | null,
    prepend: boolean,
  ): Promise<void> => {
    if (prepend) setLoadingEarlier(true);
    else setLoadingMessages(true);
    setError(null);
    try {
      const page = unwrap(await window.workstation.repository.messages(activeCase.caseId, {
        sourceId,
        chatNativeId: chatId,
        beforeCursor,
        limit: 100,
      }));
      if (prepend) {
        prependedCount.current = page.items.length;
        setMessages((current) => {
          const existing = new Set(current.map((item) => item.nativeId));
          return [...page.items.filter((item) => !existing.has(item.nativeId)), ...current];
        });
      } else {
        initialScrollPending.current = true;
        setMessages(page.items);
      }
      setMessageCursor(page.nextCursor);
    } catch (loadError) {
      setError(errorMessage(loadError));
      if (!prepend) setMessages([]);
    } finally {
      setLoadingMessages(false);
      setLoadingEarlier(false);
    }
  }, [activeCase.caseId]);

  useEffect(() => {
    setMessages([]);
    setMessageCursor(null);
    if (selectedSourceId === null || selectedChatId === null) return;
    void loadMessages(selectedSourceId, selectedChatId, null, false);
  }, [selectedSourceId, selectedChatId, loadMessages]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messageViewportRef.current,
    estimateSize: () => 112,
    getItemKey: (index) => `${messages[index]?.sourceId ?? "source"}:${messages[index]?.nativeId ?? index}`,
    overscan: 8,
  });

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    if (initialScrollPending.current) {
      initialScrollPending.current = false;
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      return;
    }
    if (prependedCount.current !== null) {
      const anchorIndex = prependedCount.current;
      prependedCount.current = null;
      virtualizer.scrollToIndex(anchorIndex, { align: "start" });
    }
  }, [messages.length, virtualizer]);

  const loadEarlier = (): void => {
    if (
      selectedSourceId === null ||
      selectedChatId === null ||
      messageCursor === null ||
      loadingEarlier
    ) return;
    void loadMessages(selectedSourceId, selectedChatId, messageCursor, true);
  };

  return (
    <section className="chat-workspace" aria-label="聊天记录预览">
      <aside className="source-pane">
        <div className="pane-heading">
          <p className="page-kicker">检材</p>
          <h1>采集账号</h1>
          <span>{sources.length} 个检材</span>
        </div>
        {loadingSources ? (
          <LoadingRows count={5} />
        ) : sources.length === 0 ? (
          <EmptyState title="没有可预览检材" description="请先在任务页接收 Field Collector 结果。" />
        ) : (
          <div className="source-list" role="listbox" aria-label="检材列表">
            {sources.map((source) => (
              <button
                type="button"
                key={source.sourceId}
                className={`source-row${source.sourceId === selectedSourceId ? " source-row--selected" : ""}`}
                role="option"
                aria-selected={source.sourceId === selectedSourceId}
                onClick={() => setSelectedSourceId(source.sourceId)}
              >
                <span className="source-row__icon"><ChatCircleText size={21} weight="duotone" /></span>
                <span className="source-row__content">
                  <strong title={source.specimenName}>{source.specimenName}</strong>
                  <small>{source.chatCount} 个会话，{source.messageCount} 条消息</small>
                  <span className={`source-status source-status--${source.collectionStatus}`}>
                    {collectionStatusLabel(source.collectionStatus)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>
      <aside className="chat-pane">
        <div className="chat-pane__header">
          <div className="chat-pane__title">
            <h2>会话</h2>
            <span>{formatCount(selectedSource?.chatCount ?? 0)} 个</span>
          </div>
          <label className="search-field search-field--compact">
            <MagnifyingGlass size={17} />
            <input
              type="search"
              value={chatSearch}
              placeholder="搜索会话"
              aria-label="搜索会话"
              disabled={selectedSourceId === null}
              onChange={(event) => setChatSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="chat-list" role="listbox" aria-label="会话列表">
          {loadingChats && chats.length === 0 ? (
            <LoadingRows count={6} />
          ) : selectedSourceId === null ? (
            <EmptyState title="选择检材" description="选择左侧检材后查看会话。" />
          ) : chats.length === 0 ? (
            <EmptyState title="没有会话" description="当前检材没有匹配的聊天会话。" />
          ) : (
            <>
              {chats.map((chat) => (
                <button
                  type="button"
                  key={`${chat.sourceId}:${chat.nativeId}`}
                  className={`chat-row${chat.nativeId === selectedChatId ? " chat-row--selected" : ""}`}
                  role="option"
                  aria-selected={chat.nativeId === selectedChatId}
                  onClick={() => setSelectedChatId(chat.nativeId)}
                >
                  <span className="chat-avatar" aria-hidden="true">
                    {chat.title.trim().charAt(0).toLocaleUpperCase("zh-CN") || "?"}
                  </span>
                  <span className="chat-row__content">
                    <span className="chat-row__topline">
                      <strong title={chat.title}>{chat.title}</strong>
                      <time>{formatCompactDate(chat.lastMessageAtUtc)}</time>
                    </span>
                    <span className="chat-row__preview">
                      <span title={chat.lastMessagePreview ?? "暂无消息摘要"}>
                        {chat.lastMessagePreview ?? "暂无消息摘要"}
                      </span>
                      <small>{formatCount(chat.messageCount)} 条</small>
                    </span>
                  </span>
                </button>
              ))}
              {chatCursor === null ? null : (
                <button
                  type="button"
                  className="load-more-button"
                  disabled={loadingChats}
                  onClick={() => selectedSourceId === null
                    ? undefined
                    : void loadChats(selectedSourceId, chatCursor, true)}
                >
                  {loadingChats ? "正在加载" : "加载更多会话"}
                </button>
              )}
            </>
          )}
        </div>
      </aside>
      <div className="message-pane">
        {selectedChat === null || selectedSource === null ? (
          <EmptyState title="选择一个会话" description="聊天内容和本地媒体会显示在这里。" />
        ) : (
          <>
            <header className="conversation-header">
              <span className="conversation-header__avatar" aria-hidden="true">
                {selectedChat.title.trim().charAt(0).toLocaleUpperCase("zh-CN") || "?"}
              </span>
              <div>
                <h2>{selectedChat.title}</h2>
                <p>
                  {selectedChat.kind === "group" ? `${selectedChat.participantCount} 名参与者，` : ""}
                  {formatCount(selectedChat.messageCount)} 条消息
                </p>
              </div>
              <div className="conversation-header__source">
                <span>检材</span>
                <strong title={selectedSource.specimenName}>{selectedSource.specimenName}</strong>
              </div>
            </header>
            {selectedSource.warning === null ? null : (
              <div className="collection-warning" role="status">
                <WarningCircle size={18} weight="fill" />
                <span>{selectedSource.warning}</span>
              </div>
            )}
            {error === null ? null : <div className="message-error"><InlineError message={error} /></div>}
            <div ref={messageViewportRef} className="message-viewport">
              {loadingMessages ? (
                <div className="message-loading"><LoadingRows count={5} /></div>
              ) : messages.length === 0 ? (
                <EmptyState title="没有消息" description="该会话没有可解析的消息记录。" />
              ) : (
                <div
                  className="virtual-message-list"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const message = messages[virtualItem.index];
                    if (message === undefined) return null;
                    const previousMessage = messages[virtualItem.index - 1];
                    const showDate = previousMessage === undefined
                      || messageDateKey(previousMessage.timestampUtc) !== messageDateKey(message.timestampUtc);
                    return (
                      <div
                        key={virtualItem.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualItem.index}
                        className="virtual-message-row"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        {virtualItem.index === 0 && messageCursor !== null ? (
                          <button
                            type="button"
                            className="load-earlier-button"
                            disabled={loadingEarlier}
                            onClick={loadEarlier}
                          >
                            <ArrowUp size={16} />
                            {loadingEarlier ? "正在加载" : "加载更早消息"}
                          </button>
                        ) : null}
                        {showDate ? (
                          <div className="message-date-separator" role="separator">
                            <span>{formatMessageDate(message.timestampUtc)}</span>
                          </div>
                        ) : null}
                        <MessageItem message={message} onError={setError} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function MessageItem({
  message,
  onError,
}: {
  message: MessageView;
  onError: (message: string) => void;
}): React.JSX.Element {
  if (isSystemMessage(message)) {
    return (
      <div className="system-message">
        <span>{message.text ?? message.caption ?? messageTypeLabel(message.type)}</span>
        <time>{formatMessageTime(message.timestampUtc)}</time>
      </div>
    );
  }
  const body = message.isRevoked
    ? "此消息已撤回"
    : message.text ?? message.caption ?? (message.attachments.length === 0
      ? messageTypeLabel(message.type)
      : null);
  return (
    <article className={`message-line${message.fromMe ? " message-line--outgoing" : ""}`}>
      <div className="message-bubble">
        {message.fromMe || message.senderDisplayName === null ? null : (
          <strong className="message-bubble__sender">{message.senderDisplayName}</strong>
        )}
        {message.isForwarded ? <span className="message-bubble__forwarded">已转发</span> : null}
        {message.quotedMessageId === null ? null : (
          <div className="quoted-message">引用消息 {message.quotedMessageId}</div>
        )}
        {body === null ? null : (
          <p className={message.isRevoked ? "message-bubble__revoked" : undefined}>{body}</p>
        )}
        {message.attachments.length === 0 ? null : (
          <div className="attachment-stack">
            {message.attachments.map((attachment) => (
              <AttachmentPreview
                attachment={attachment}
                key={attachment.opaqueId}
                onError={onError}
              />
            ))}
          </div>
        )}
        <div className="message-bubble__meta">
          {message.isStarred ? <Star size={13} weight="fill" aria-label="已标星" /> : null}
          <span>{messageTypeLabel(message.type)}</span>
          <time>{formatMessageTime(message.timestampUtc)}</time>
        </div>
      </div>
    </article>
  );
}

function AttachmentPreview({
  attachment,
  onError,
}: {
  attachment: AttachmentView;
  onError: (message: string) => void;
}): React.JSX.Element {
  const open = async (): Promise<void> => {
    try {
      unwrap(await window.workstation.attachments.open(attachment.opaqueId));
    } catch (openError) {
      onError(errorMessage(openError));
    }
  };
  if (attachment.status !== "available" || attachment.url === null) {
    return (
      <div className="attachment-missing">
        <WarningCircle size={18} />
        <div>
          <strong>{attachment.fileName ?? attachmentLabel(attachment.kind)}</strong>
          <span>{attachment.status === "missing" ? "媒体文件缺失" : "媒体采集失败"}</span>
        </div>
      </div>
    );
  }
  if (attachment.kind === "image") {
    return (
      <ImagePreview
        attachment={attachment}
        url={attachment.url}
        onOpen={() => void open()}
      />
    );
  }
  if (attachment.kind === "audio") {
    return (
      <div className="attachment-player attachment-player--audio">
        <div><FileAudio size={19} /><span>{attachment.fileName ?? "语音消息"}</span></div>
        <audio controls preload="metadata" src={attachment.url} />
      </div>
    );
  }
  if (attachment.kind === "video") {
    return (
      <div className="attachment-player attachment-player--video">
        <video controls preload="metadata" src={attachment.url} />
        <div><FileVideo size={18} /><span>{attachment.fileName ?? "视频"}</span></div>
      </div>
    );
  }
  return (
    <button type="button" className="attachment-file" onClick={() => void open()}>
      <span className="attachment-file__icon"><File size={23} weight="duotone" /></span>
      <span>
        <strong>{attachment.fileName ?? attachmentLabel(attachment.kind)}</strong>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </span>
      <span className="attachment-file__action">打开</span>
    </button>
  );
}

function ImagePreview({
  attachment,
  url,
  onOpen,
}: {
  attachment: AttachmentView;
  url: string;
  onOpen: () => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="attachment-missing">
        <FileImage size={18} />
        <div><strong>{attachment.fileName ?? "图片"}</strong><span>图片无法显示</span></div>
      </div>
    );
  }
  return (
    <button type="button" className="image-preview" onClick={onOpen} title="打开原文件">
      <img
        src={url}
        alt={attachment.fileName ?? "聊天图片"}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function isSystemMessage(message: MessageView): boolean {
  return new Set([
    "gp2",
    "e2e_notification",
    "notification_template",
    "call_log",
    "event_creation",
  ]).has(message.type);
}

function messageTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    chat: "文本",
    image: "图片",
    ptt: "语音",
    audio: "音频",
    video: "视频",
    document: "文档",
    sticker: "贴图",
    poll_creation: "投票",
    event_creation: "事件",
    call_log: "通话记录",
    gp2: "群组事件",
    e2e_notification: "系统通知",
  };
  return labels[type] ?? type;
}

function attachmentLabel(kind: AttachmentView["kind"]): string {
  return {
    image: "图片",
    audio: "音频",
    video: "视频",
    document: "文档",
    other: "附件",
  }[kind];
}

function collectionStatusLabel(status: EvidenceSource["collectionStatus"]): string {
  return status === "complete" ? "采集完成" : status === "cancelled" ? "采集已取消" : "采集失败";
}

function formatMessageTime(value: string | null): string {
  if (value === null) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function messageDateKey(value: string | null): string {
  if (value === null) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatMessageDate(value: string | null): string {
  if (value === null) return "日期未知";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
