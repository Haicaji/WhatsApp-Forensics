import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Broadcast,
  CaretDown,
  ChatCircleText,
  ChatsCircle,
  CircleNotch,
  File,
  FileAudio,
  FileHtml,
  FileImage,
  FileVideo,
  IdentificationCard,
  MagnifyingGlass,
  Megaphone,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Star,
  UserCircle,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type {
  AttachmentView,
  CallEvidenceView,
  CaseSummary,
  ChannelEvidenceView,
  ChannelMessageView,
  ChatSummary,
  CommunityEvidenceView,
  EvidenceSource,
  MessageView,
  SourceFeatureAvailability,
  SourceWorkspaceView,
  StatusEvidenceView,
} from "@wafc/domain";

import { EmptyState, InlineError, LoadingRows } from "../components/Feedback";
import {
  errorMessage,
  formatBytes,
  formatCalendarDate as formatMessageDate,
  formatClockTime as formatMessageTime,
  formatCompactDate,
  formatCount,
  formatDateTime as formatFullDateTime,
  unwrap,
} from "../lib/api";

type WorkspaceSection = "chats" | "calls" | "statuses" | "channels" | "communities" | "profile";

export function ChatPage({ activeCase }: { activeCase: CaseSummary }): React.JSX.Element {
  const [sources, setSources] = useState<EvidenceSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceWorkspace, setSourceWorkspace] = useState<SourceWorkspaceView | null>(null);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>("chats");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingSourceWorkspace, setLoadingSourceWorkspace] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [exportingSourceId, setExportingSourceId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [conversationInfoOpen, setConversationInfoOpen] = useState(false);
  const messageViewportRef = useRef<HTMLDivElement>(null);
  const initialScrollPending = useRef(false);
  const prependedCount = useRef<number | null>(null);
  const pendingChatSelection = useRef<string | null>(null);

  const selectedSource = sources.find((item) => item.sourceId === selectedSourceId) ?? null;
  const selectedChat = chats.find((item) => item.nativeId === selectedChatId) ?? null;

  const exportOfflinePreview = useCallback(async (source: EvidenceSource): Promise<void> => {
    if (exportingSourceId !== null) return;
    setExportingSourceId(source.sourceId);
    setExportError(null);
    try {
      unwrap(await window.workstation.repository.exportOfflinePreview(
        activeCase.caseId,
        source.sourceId,
      ));
    } catch (exportError) {
      setExportError(errorMessage(exportError));
    } finally {
      setExportingSourceId(null);
    }
  }, [activeCase.caseId, exportingSourceId]);

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

  useEffect(() => {
    let cancelled = false;
    setSourceWorkspace(null);
    setWorkspaceError(null);
    setConversationInfoOpen(false);
    if (selectedSourceId === null) return;
    setLoadingSourceWorkspace(true);
    void window.workstation.repository
      .sourceWorkspace(activeCase.caseId, selectedSourceId)
      .then((result) => {
        if (cancelled) return;
        try {
          setSourceWorkspace(unwrap(result));
        } catch (loadError) {
          setWorkspaceError(errorMessage(loadError));
        } finally {
          setLoadingSourceWorkspace(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCase.caseId, selectedSourceId]);

  const loadChats = useCallback(async (
    sourceId: string,
    cursor: string | null,
    append: boolean,
  ): Promise<void> => {
    setLoadingChats(true);
    setError(null);
    try {
      let page = unwrap(await window.workstation.repository.chats(activeCase.caseId, {
        sourceId,
        search: chatSearch,
        cursor,
        limit: 80,
      }));
      const loadedItems = [...page.items];
      const preferredChatId = append ? null : pendingChatSelection.current;
      while (
        preferredChatId !== null
        && chatSearch === ""
        && !loadedItems.some((item) => item.nativeId === preferredChatId)
        && page.nextCursor !== null
      ) {
        page = unwrap(await window.workstation.repository.chats(activeCase.caseId, {
          sourceId,
          search: "",
          cursor: page.nextCursor,
          limit: 200,
        }));
        loadedItems.push(...page.items);
      }
      setChats((current) => append ? [...current, ...loadedItems] : loadedItems);
      setChatCursor(page.nextCursor);
      if (!append) {
        const preferredChat = preferredChatId === null
          ? null
          : loadedItems.find((item) => item.nativeId === preferredChatId) ?? null;
        setSelectedChatId(preferredChat?.nativeId ?? loadedItems[0]?.nativeId ?? null);
        if (preferredChatId !== null) {
          pendingChatSelection.current = null;
          if (preferredChat === null) {
            setError("没有找到该社群条目对应的聊天记录。");
          }
        }
        setConversationInfoOpen(false);
      }
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

  const selectWorkspaceSection = (section: WorkspaceSection): void => {
    setWorkspaceSection(section);
    setConversationInfoOpen(false);
  };

  const selectChat = (chatId: string, showInfo = false): void => {
    setSelectedChatId(chatId);
    setConversationInfoOpen(showInfo);
  };

  const openCommunityChat = (chatId: string): void => {
    if (selectedSourceId === null) return;
    setWorkspaceSection("chats");
    setConversationInfoOpen(false);
    const existingChat = chatSearch === ""
      ? chats.find((item) => item.nativeId === chatId) ?? null
      : null;
    if (existingChat !== null) {
      pendingChatSelection.current = null;
      setSelectedChatId(existingChat.nativeId);
      return;
    }
    pendingChatSelection.current = chatId;
    if (chatSearch !== "") {
      setChatSearch("");
      return;
    }
    void loadChats(selectedSourceId, null, false);
  };

  return (
    <section className="chat-workspace" aria-label="聊天记录预览">
      <aside className="source-pane">
        <div className="pane-heading pane-heading--accounts">
          <h1>WhatsApp 账号</h1>
        </div>
        {loadingSources ? (
          <LoadingRows count={5} />
        ) : sources.length === 0 ? (
          <EmptyState title="没有可预览检材" description="请先在任务页接收 Field Collector 结果。" />
        ) : (
          <div className="source-list" aria-label="WhatsApp 账号列表">
            {sources.map((source) => (
              <div
                key={source.sourceId}
                className={`source-row${source.sourceId === selectedSourceId ? " source-row--selected" : ""}`}
              >
                <button
                  type="button"
                  className="source-row__select"
                  aria-pressed={source.sourceId === selectedSourceId}
                  onClick={() => setSelectedSourceId(source.sourceId)}
                >
                  <strong title={source.specimenName}>{source.specimenName}</strong>
                </button>
                <button
                  type="button"
                  className="source-row__export"
                  aria-label={`导出 ${source.specimenName} 的离线 Web 预览`}
                  title="导出离线 Web 预览"
                  disabled={exportingSourceId !== null}
                  onClick={() => void exportOfflinePreview(source)}
                >
                  {exportingSourceId === source.sourceId
                    ? <CircleNotch size={20} className="spin" />
                    : <FileHtml size={20} />}
                </button>
              </div>
            ))}
            {exportError !== null ? (
              <div
                className="source-export-feedback source-export-feedback--error"
                role="alert"
              >
                {exportError}
              </div>
            ) : null}
          </div>
        )}
      </aside>
      <div className="whatsapp-evidence" aria-label="WhatsApp 证据浏览器">
        <WorkspaceNavigation
          activeSection={workspaceSection}
          onSelect={selectWorkspaceSection}
        />
        {workspaceSection === "chats" ? (
          <>
            <aside className="chat-pane">
              <div className="chat-pane__header">
                <div className="chat-pane__title">
                  <h2>对话</h2>
                  <span>{formatCount(sourceWorkspace?.visibleChatCount ?? selectedSource?.chatCount ?? 0)} 个</span>
                </div>
                <label className="search-field search-field--compact">
                  <MagnifyingGlass size={17} />
                  <input
                    type="search"
                    value={chatSearch}
                    placeholder="搜索对话"
                    aria-label="搜索对话"
                    disabled={selectedSourceId === null}
                    onChange={(event) => setChatSearch(event.target.value)}
                  />
                </label>
              </div>
              <div className="chat-list" role="listbox" aria-label="对话列表">
                {loadingChats && chats.length === 0 ? (
                  <LoadingRows count={6} />
                ) : selectedSourceId === null ? (
                  <EmptyState title="选择检材" description="选择左侧检材后查看对话。" />
                ) : chats.length === 0 ? (
                  <EmptyState title="没有对话" description="当前检材没有匹配的对话记录。" />
                ) : (
                  <>
                    {chats.map((chat) => (
                      <div
                        key={`${chat.sourceId}:${chat.nativeId}`}
                        className={`chat-row${chat.community?.role === "group" ? " chat-row--community" : ""}${chat.nativeId === selectedChatId ? " chat-row--selected" : ""}`}
                        data-community-id={chat.community?.id}
                        data-community-role={chat.community?.role ?? "standalone"}
                        role="option"
                        tabIndex={0}
                        aria-selected={chat.nativeId === selectedChatId}
                        onClick={() => selectChat(chat.nativeId)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectChat(chat.nativeId);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className={`chat-avatar${chat.community === null
                            ? " chat-avatar--standalone"
                            : ` chat-avatar--${chat.community.role}`}`}
                          aria-label={`查看${chat.title}信息`}
                          title="查看信息"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectChat(chat.nativeId, true);
                          }}
                        >
                          {chat.community === null ? (
                            <span className="chat-avatar__single">
                              <AvatarContent
                                url={chat.avatarUrl}
                                fallback={initialFor(chat.title)}
                              />
                            </span>
                          ) : chat.community.role === "announcement" ? (
                            <span className="chat-avatar__single" aria-hidden="true">
                              <AvatarContent
                                url={chat.avatarUrl}
                                fallback={<UsersThree size={20} weight="fill" />}
                              />
                            </span>
                          ) : (
                            <span className="chat-avatar__pair" aria-hidden="true">
                              <span className="chat-avatar__community-parent">
                                <AvatarContent
                                  url={chat.community.avatarUrl}
                                  fallback={<UsersThree size={16} weight="fill" />}
                                />
                              </span>
                              <span className="chat-avatar__community-child">
                                <AvatarContent
                                  url={chat.avatarUrl}
                                  fallback={initialFor(chat.title)}
                                />
                              </span>
                            </span>
                          )}
                        </button>
                        <span className="chat-row__content">
                          {chat.community?.role !== "group" ? null : (
                            <span
                              className="chat-row__community"
                              data-community-title={chat.community.title}
                              title={`所属社群：${chat.community.title}`}
                            >
                              <span>{chat.community.title}</span>
                            </span>
                          )}
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
                      </div>
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
                        {loadingChats ? "正在加载" : "加载更多对话"}
                      </button>
                    )}
                  </>
                )}
              </div>
            </aside>
            <div className="conversation-stage">
              <div className="message-pane">
                {selectedChat === null || selectedSource === null ? (
                  <EmptyState title="选择一个对话" description="聊天内容和本地媒体会显示在这里。" />
                ) : (
                  <>
                    <header className="conversation-header">
                      <button
                        type="button"
                        className="conversation-header__avatar"
                        aria-label={`查看${selectedChat.title}信息`}
                        title="查看信息"
                        onClick={() => setConversationInfoOpen(true)}
                      >
                        <AvatarContent
                          url={selectedChat.avatarUrl}
                          fallback={initialFor(selectedChat.title)}
                        />
                      </button>
                      <button
                        type="button"
                        className="conversation-header__identity"
                        onClick={() => setConversationInfoOpen(true)}
                      >
                        <h2>{selectedChat.title}</h2>
                        <p>
                          {selectedChat.community === null
                            ? null
                            : selectedChat.community.role === "group"
                              ? `${selectedChat.community.title} · 社群群组 · `
                              : null}
                          {selectedChat.kind === "group" ? `${selectedChat.participantCount} 名参与者，` : ""}
                          {formatCount(selectedChat.messageCount)} 条消息
                        </p>
                      </button>
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
                        <EmptyState title="没有消息" description="该对话没有可解析的消息记录。" />
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
              {conversationInfoOpen && selectedChat !== null && selectedSource !== null ? (
                <ConversationInfoDrawer
                  chat={selectedChat}
                  source={selectedSource}
                  onClose={() => setConversationInfoOpen(false)}
                />
              ) : null}
            </div>
          </>
        ) : (
          <SourceFeatureView
            key={workspaceSection}
            section={workspaceSection}
            source={selectedSource}
            workspace={sourceWorkspace}
            loading={loadingSourceWorkspace}
            error={workspaceError}
            onOpenChat={openCommunityChat}
          />
        )}
      </div>
    </section>
  );
}

function WorkspaceNavigation({
  activeSection,
  onSelect,
}: {
  activeSection: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}): React.JSX.Element {
  const entries: Array<{
    section: Exclude<WorkspaceSection, "profile">;
    label: string;
    icon: React.ReactNode;
  }> = [
    { section: "chats", label: "对话", icon: <ChatsCircle size={22} weight="fill" /> },
    { section: "calls", label: "通话", icon: <Phone size={22} /> },
    { section: "statuses", label: "动态", icon: <CircleNotch size={22} /> },
    { section: "channels", label: "频道", icon: <Broadcast size={22} /> },
    { section: "communities", label: "社群", icon: <UsersThree size={22} /> },
  ];
  return (
    <aside className="whatsapp-feature-rail" aria-label="WhatsApp 功能栏">
      <nav aria-label="WhatsApp 数据类型">
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.section}
            className={`whatsapp-feature-button${activeSection === entry.section ? " whatsapp-feature-button--active" : ""}`}
            aria-label={entry.label}
            aria-pressed={activeSection === entry.section}
            title={entry.label}
            data-workspace-section={entry.section}
            onClick={() => onSelect(entry.section)}
          >
            {entry.icon}
          </button>
        ))}
      </nav>
      <button
        type="button"
        className={`whatsapp-feature-button whatsapp-feature-button--profile${activeSection === "profile" ? " whatsapp-feature-button--active" : ""}`}
        aria-label="个人资料"
        aria-pressed={activeSection === "profile"}
        title="个人资料"
        data-workspace-section="profile"
        onClick={() => onSelect("profile")}
      >
        <UserCircle size={24} weight="fill" />
      </button>
    </aside>
  );
}

type FeatureRecord = CallEvidenceView | StatusEvidenceView | ChannelEvidenceView | CommunityEvidenceView;

function SourceFeatureView({
  section,
  source,
  workspace,
  loading,
  error,
  onOpenChat,
}: {
  section: Exclude<WorkspaceSection, "chats">;
  source: EvidenceSource | null;
  workspace: SourceWorkspaceView | null;
  loading: boolean;
  error: string | null;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const records = featureRecords(section, workspace);
  const filteredRecords = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("zh-CN");
    if (normalized === "") return records;
    return records.filter((record) => record.title.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [records, search]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId((current) => filteredRecords.some((record) => record.id === current)
      ? current
      : filteredRecords[0]?.id ?? null);
  }, [filteredRecords]);

  if (section === "profile") {
    return <ProfileView source={source} workspace={workspace} loading={loading} error={error} />;
  }

  if (section === "communities") {
    return (
      <CommunityFeatureView
        source={source}
        workspace={workspace}
        loading={loading}
        error={error}
        onOpenChat={onOpenChat}
      />
    );
  }

  const availability = workspace?.availability[section] ?? null;
  const selected = filteredRecords.find((record) => record.id === selectedId) ?? null;
  const config = featureConfiguration(section);
  return (
    <>
      <aside className="feature-pane" aria-label={`${config.title}列表`}>
        <div className="feature-pane__header">
          <div className="feature-pane__title">
            <h2>{config.title}</h2>
            <span>{formatCount(records.length)} 个</span>
          </div>
          {config.searchPlaceholder === null ? null : (
            <label className="search-field search-field--compact">
              <MagnifyingGlass size={17} />
              <input
                type="search"
                value={search}
                placeholder={config.searchPlaceholder}
                aria-label={config.searchPlaceholder}
                disabled={source === null}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
        </div>
        <div className="feature-list" role="listbox" aria-label={`${config.title}记录`}>
          {loading ? (
            <LoadingRows count={6} />
          ) : error !== null ? (
            <div className="feature-list__feedback"><InlineError message={error} /></div>
          ) : source === null ? (
            <EmptyState title="选择检材" description={`选择左侧检材后查看${config.title}。`} />
          ) : records.length === 0 ? (
            <FeatureAvailabilityEmpty title={config.emptyTitle} availability={availability} />
          ) : filteredRecords.length === 0 ? (
            <EmptyState title="没有匹配记录" />
          ) : (
            <>
              <h3 className="feature-list__group-title">{config.listLabel}</h3>
              {filteredRecords.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={`feature-row${record.id === selectedId ? " feature-row--selected" : ""}`}
                  role="option"
                  aria-selected={record.id === selectedId}
                  onClick={() => setSelectedId(record.id)}
                >
                  <span className="feature-row__avatar">{featureRecordIcon(section, record)}</span>
                  <span className="feature-row__content">
                    <span className="feature-row__topline">
                      <strong title={record.title}>{record.title}</strong>
                      <time>{featureRecordDate(record)}</time>
                    </span>
                    <span>{featureRecordSummary(section, record)}</span>
                  </span>
                </button>
              ))}
              {availability?.truncated === true ? (
                <p className="feature-list__limit">仅显示前 {SOURCE_FEATURE_DISPLAY_LIMIT} 条记录</p>
              ) : null}
            </>
          )}
        </div>
      </aside>
      <main
        className={`feature-detail${section === "channels" ? " feature-detail--channel" : ""}`}
        aria-label={`${config.title}详情`}
      >
        {loading ? (
          <div className="feature-detail__loading"><LoadingRows count={4} /></div>
        ) : selected === null ? (
          <FeatureHero
            icon={config.heroIcon}
            title={config.heroTitle}
            description={config.heroDescription}
          />
        ) : (
          <FeatureRecordDetail section={section} record={selected} source={source} />
        )}
      </main>
    </>
  );
}

function CommunityFeatureView({
  source,
  workspace,
  loading,
  error,
  onOpenChat,
}: {
  source: EvidenceSource | null;
  workspace: SourceWorkspaceView | null;
  loading: boolean;
  error: string | null;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const communities = useMemo(() => workspace?.communities ?? [], [workspace]);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [expandedCommunityIds, setExpandedCommunityIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedCommunityId((current) => communities.some((item) => item.id === current)
      ? current
      : communities[0]?.id ?? null);
    setExpandedCommunityIds(new Set(communities.map((item) => item.id)));
  }, [communities]);

  const selected = communities.find((item) => item.id === selectedCommunityId) ?? null;
  const availability = workspace?.availability.communities ?? null;

  return (
    <>
      <aside className="feature-pane community-pane" aria-label="社群列表">
        <div className="community-pane__header">
          <h2>社群</h2>
          <span>{formatCount(communities.length)} 个</span>
        </div>
        <div className="community-collection-list" role="listbox" aria-label="已采集社群">
          {loading ? (
            <LoadingRows count={5} />
          ) : error !== null ? (
            <div className="feature-list__feedback"><InlineError message={error} /></div>
          ) : source === null ? (
            <EmptyState title="选择检材" description="选择左侧检材后查看社群。" />
          ) : communities.length === 0 ? (
            <FeatureAvailabilityEmpty title="没有社群记录" availability={availability} />
          ) : (
            communities.map((community) => (
              <CommunityCollection
                community={community}
                selected={community.id === selectedCommunityId}
                expanded={expandedCommunityIds.has(community.id)}
                key={community.id}
                onToggle={() => {
                  setSelectedCommunityId(community.id);
                  setExpandedCommunityIds((current) => {
                    const next = new Set(current);
                    if (next.has(community.id)) next.delete(community.id);
                    else next.add(community.id);
                    return next;
                  });
                }}
                onOpenChat={onOpenChat}
              />
            ))
          )}
        </div>
      </aside>
      <main className="feature-detail community-detail" aria-label="社群详情">
        {loading ? (
          <div className="feature-detail__loading"><LoadingRows count={4} /></div>
        ) : selected === null ? (
          <FeatureHero
            icon={<UsersThree size={48} weight="duotone" />}
            title="社群"
            description="社群会按合集展示主对话和其中的群组。"
          />
        ) : (
          <CommunityCollectionDetail community={selected} onOpenChat={onOpenChat} />
        )}
      </main>
    </>
  );
}

function CommunityCollection({
  community,
  selected,
  expanded,
  onToggle,
  onOpenChat,
}: {
  community: CommunityEvidenceView;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const announcement = community.childGroups.find((group) => group.role === "announcement") ?? null;
  const groups = community.childGroups.filter((group) => group.role === "group");
  return (
    <section
      className={`community-collection${selected ? " community-collection--selected" : ""}`}
      data-community-id={community.id}
    >
      <button
        type="button"
        className="community-collection__heading"
        role="option"
        aria-selected={selected}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="community-collection__avatar"><UsersThree size={22} weight="fill" /></span>
        <span className="community-collection__name">
          <strong title={community.title}>{community.title}</strong>
          <small>{formatCount(groups.length)} 个群组</small>
        </span>
        <CaretDown
          className={`community-collection__chevron${expanded ? " community-collection__chevron--expanded" : ""}`}
          size={16}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="community-collection__children">
          {announcement === null ? null : (
            <CommunityChildRow
              group={announcement}
              communityTitle={community.title}
              onOpenChat={onOpenChat}
            />
          )}
          {groups.map((group) => (
            <CommunityChildRow
              group={group}
              communityTitle={community.title}
              key={group.id}
              onOpenChat={onOpenChat}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CommunityChildRow({
  group,
  communityTitle,
  onOpenChat,
}: {
  group: CommunityEvidenceView["childGroups"][number];
  communityTitle: string;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const announcement = group.role === "announcement";
  return (
    <button
      type="button"
      className={`community-child-row community-child-row--${group.role}`}
      data-community-child-id={group.id}
      data-community-child-role={group.role}
      aria-label={`打开${announcement ? communityTitle : group.title}聊天预览`}
      title="打开聊天预览"
      onClick={() => onOpenChat(group.id)}
    >
      <span className="community-child-row__icon">
        {announcement
          ? <UsersThree size={18} weight="fill" />
          : <ChatCircleText size={19} weight="duotone" />}
      </span>
      <span className="community-child-row__content">
        <strong title={announcement ? communityTitle : group.title}>
          {announcement ? communityTitle : group.title}
        </strong>
        <small title={group.title}>
          {announcement ? "社群主对话" : "群组"}
        </small>
      </span>
    </button>
  );
}

function CommunityCollectionDetail({
  community,
  onOpenChat,
}: {
  community: CommunityEvidenceView;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const announcement = community.childGroups.find((group) => group.role === "announcement") ?? null;
  const groups = community.childGroups.filter((group) => group.role === "group");
  return (
    <article className="community-detail__content" data-community-detail-id={community.id}>
      <header className="community-detail__identity">
        <span><UsersThree size={34} weight="fill" /></span>
        <div>
          <p>社群</p>
          <h1>{community.title}</h1>
          {community.description === null ? null : <small>{community.description}</small>}
        </div>
      </header>
      <section className="community-detail__section" aria-label="社群主对话">
        <h2>主对话</h2>
        {announcement === null ? (
          <p className="community-detail__empty">该次采集没有建立社群主对话关系。</p>
        ) : (
          <CommunityDetailGroup
            group={announcement}
            communityTitle={community.title}
            onOpenChat={onOpenChat}
          />
        )}
      </section>
      <section className="community-detail__section" aria-label="社群中的群组">
        <div className="community-detail__section-heading">
          <h2>你所在的群组</h2>
          <span>{formatCount(groups.length)} 个</span>
        </div>
        {groups.length === 0 ? (
          <p className="community-detail__empty">该次采集没有记录其他所属群组。</p>
        ) : (
          groups.map((group) => (
            <CommunityDetailGroup
              group={group}
              communityTitle={community.title}
              key={group.id}
              onOpenChat={onOpenChat}
            />
          ))
        )}
      </section>
    </article>
  );
}

function CommunityDetailGroup({
  group,
  communityTitle,
  onOpenChat,
}: {
  group: CommunityEvidenceView["childGroups"][number];
  communityTitle: string;
  onOpenChat: (chatId: string) => void;
}): React.JSX.Element {
  const announcement = group.role === "announcement";
  return (
    <button
      type="button"
      className={`community-detail-group community-detail-group--${group.role}`}
      aria-label={`打开${announcement ? communityTitle : group.title}聊天预览`}
      title="打开聊天预览"
      onClick={() => onOpenChat(group.id)}
    >
      <span>
        {announcement
          ? <UsersThree size={21} weight="fill" />
          : <ChatCircleText size={21} weight="duotone" />}
      </span>
      <div>
        <strong>{announcement ? communityTitle : group.title}</strong>
        <small>{announcement ? "社群主对话" : "群组"}</small>
      </div>
    </button>
  );
}

const SOURCE_FEATURE_DISPLAY_LIMIT = 500;

function ProfileView({
  source,
  workspace,
  loading,
  error,
}: {
  source: EvidenceSource | null;
  workspace: SourceWorkspaceView | null;
  loading: boolean;
  error: string | null;
}): React.JSX.Element {
  const name = workspace?.account.displayName
    ?? workspace?.account.formattedPhoneNumber
    ?? workspace?.account.nativeId
    ?? "未选择账号";
  return (
    <>
      <aside className="feature-pane profile-pane" aria-label="个人资料菜单">
        <div className="profile-pane__header">
          <span className="profile-avatar">{initialFor(name)}</span>
          <div>
            <h2>{name}</h2>
          </div>
        </div>
        <div className="profile-menu">
          <div className="profile-menu__row profile-menu__row--active">
            <IdentificationCard size={21} />
            <span><strong>账号资料</strong><small>名称、账号标识和简介</small></span>
          </div>
        </div>
      </aside>
      <main className="feature-detail profile-detail" aria-label="账号资料">
        {loading ? (
          <div className="feature-detail__loading"><LoadingRows count={5} /></div>
        ) : error !== null ? (
          <InlineError message={error} />
        ) : source === null || workspace === null ? (
          <FeatureHero
            icon={<UserCircle size={52} weight="duotone" />}
            title="选择一个检材账号"
            description="账号资料会显示在这里。"
          />
        ) : (
          <div className="profile-card">
            <span className="profile-card__avatar">{initialFor(name)}</span>
            <h1>{name}</h1>
            <p>{workspace.account.about ?? "该采集结果没有账号简介。"}</p>
            <dl className="evidence-detail-list">
              <div><dt>账号标识</dt><dd>{workspace.account.nativeId ?? "未采集"}</dd></div>
              <div><dt>电话号码</dt><dd>{workspace.account.formattedPhoneNumber ?? "未采集"}</dd></div>
              <div><dt>检材名称</dt><dd>{source.specimenName}</dd></div>
              <div><dt>采集状态</dt><dd>{collectionStatusLabel(source.collectionStatus)}</dd></div>
              <div><dt>对话</dt><dd>{formatCount(source.chatCount)} 个</dd></div>
              <div><dt>消息</dt><dd>{formatCount(source.messageCount)} 条</dd></div>
              <div><dt>媒体</dt><dd>{formatCount(source.mediaCount)} 个</dd></div>
            </dl>
          </div>
        )}
      </main>
    </>
  );
}

function ConversationInfoDrawer({
  chat,
  source,
  onClose,
}: {
  chat: ChatSummary;
  source: EvidenceSource;
  onClose: () => void;
}): React.JSX.Element {
  const group = chat.kind === "group";
  const phoneDisplay = chat.formattedPhoneNumber
    ?? (chat.phoneNumber === null ? "未采集" : `+${chat.phoneNumber}`);
  return (
    <aside className="conversation-info" aria-label={group ? "群组信息" : "联系人信息"}>
      <header className="conversation-info__header">
        <button type="button" aria-label="关闭资料" title="关闭" onClick={onClose}>
          <X size={20} />
        </button>
        <h2>{group ? "群组信息" : "联系人信息"}</h2>
      </header>
      <div className="conversation-info__body">
        <span className="conversation-info__avatar">
          <AvatarContent url={chat.avatarUrl} fallback={initialFor(chat.title)} />
        </span>
        <h1>{chat.title}</h1>
        <p>{group ? `${formatCount(chat.participantCount)} 名参与者` : "个人对话"}</p>
        <section className="conversation-info__section">
          <h3>会话信息</h3>
          <dl className="evidence-detail-list">
            {group ? null : <div><dt>电话号码</dt><dd>{phoneDisplay}</dd></div>}
            <div><dt>WhatsApp 标识</dt><dd>{chat.nativeId}</dd></div>
            <div><dt>消息</dt><dd>{formatCount(chat.messageCount)} 条</dd></div>
            <div><dt>最后消息</dt><dd>{formatFullDateTime(chat.lastMessageAtUtc)}</dd></div>
            {chat.community?.role !== "group" ? null : (
              <>
                <div><dt>所属社群</dt><dd>{chat.community.title}</dd></div>
                <div><dt>社群角色</dt><dd>社群群组</dd></div>
              </>
            )}
          </dl>
        </section>
        <section className="conversation-info__section conversation-info__summary-row">
          <FileImage size={22} />
          <div><strong>影音内容、链接和文档</strong><span>已索引媒体</span></div>
          <b>{formatCount(chat.mediaCount)}</b>
        </section>
        <section className="conversation-info__section conversation-info__summary-row">
          <Star size={22} />
          <div><strong>已加星标消息</strong><span>已索引消息</span></div>
          <b>{formatCount(chat.starredMessageCount)}</b>
        </section>
        <section className="conversation-info__section">
          <h3>检材来源</h3>
          <dl className="evidence-detail-list">
            <div><dt>检材名称</dt><dd>{source.specimenName}</dd></div>
            <div><dt>采集状态</dt><dd>{collectionStatusLabel(source.collectionStatus)}</dd></div>
            <div><dt>导入时间</dt><dd>{formatFullDateTime(source.importedAtUtc)}</dd></div>
          </dl>
        </section>
      </div>
    </aside>
  );
}

function ChannelMessageFeed({
  channel,
}: {
  channel: ChannelEvidenceView;
}): React.JSX.Element {
  const [mediaError, setMediaError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      messages: ChannelMessageView[];
    }> = [];
    for (const message of channel.messages) {
      const key = messageDateKey(message.timestampUtc);
      const current = result.at(-1);
      if (current?.key === key) {
        current.messages.push(message);
      } else {
        result.push({
          key,
          label: formatMessageDate(message.timestampUtc),
          messages: [message],
        });
      }
    }
    return result;
  }, [channel.messages]);

  useEffect(() => {
    setMediaError(null);
  }, [channel.id]);

  return (
    <section className="channel-feed" aria-label={`${channel.title}频道消息`}>
      <header className="channel-feed__header">
        <span className="channel-feed__avatar">
          <AvatarContent
            url={channel.avatarUrl}
            fallback={<Broadcast size={23} weight="fill" />}
          />
        </span>
        <div className="channel-feed__identity">
          <h1 title={channel.title}>{channel.title}</h1>
          <p title={channel.description ?? undefined}>
            {channel.description ?? "该频道没有可显示的说明。"}
          </p>
        </div>
        <div className="channel-feed__summary" aria-label="频道摘要">
          <strong>{formatCount(channel.eventCount)} 条更新</strong>
          <span>
            {channel.subscribersCount === null
              ? "关注者未记录"
              : `${formatCount(channel.subscribersCount)} 位关注者`}
          </span>
        </div>
      </header>
      <div className="channel-feed__viewport">
        {mediaError === null ? null : (
          <div className="channel-feed__error"><InlineError message={mediaError} /></div>
        )}
        {channel.historyComplete === false ? (
          <div className="channel-feed__warning">
            <WarningCircle size={17} />
            <span>采集结果未到达该频道的历史边界，当前消息可能不完整。</span>
          </div>
        ) : null}
        {channel.messages.length === 0 ? (
          <EmptyState title="没有频道消息" description="该频道没有可显示的已采集更新。" />
        ) : (
          <div className="channel-feed__column">
            {channel.messagesTruncated ? (
              <p className="channel-feed__limit">
                频道更新较多，当前显示最近 {SOURCE_FEATURE_DISPLAY_LIMIT} 条。
              </p>
            ) : null}
            {groups.map((group) => (
              <section className="channel-message-group" key={group.key}>
                <div className="message-date-separator"><span>{group.label}</span></div>
                {group.messages.map((message) => (
                  <ChannelMessageItem
                    key={message.id}
                    message={message}
                    onError={setMediaError}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ChannelMessageItem({
  message,
  onError,
}: {
  message: ChannelMessageView;
  onError: (message: string) => void;
}): React.JSX.Element {
  const body = message.isRevoked
    ? "此频道消息已撤回"
    : message.text ?? message.caption ?? (message.attachments.length === 0
      ? messageTypeLabel(message.type)
      : null);
  return (
    <article className="channel-message" data-channel-message-id={message.id}>
      {message.isForwarded ? <span className="channel-message__forwarded">已转发</span> : null}
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
      {body === null ? null : (
        <p className={message.isRevoked ? "channel-message__revoked" : undefined}>{body}</p>
      )}
      <footer className="channel-message__meta">
        {message.isStarred ? <Star size={13} weight="fill" aria-label="已标星" /> : null}
        <span>{messageTypeLabel(message.type)}</span>
        <time>{formatMessageTime(message.timestampUtc)}</time>
      </footer>
    </article>
  );
}

function FeatureRecordDetail({
  section,
  record,
  source,
}: {
  section: Exclude<WorkspaceSection, "chats" | "profile">;
  record: FeatureRecord;
  source: EvidenceSource | null;
}): React.JSX.Element {
  if (section === "calls") {
    const call = record as CallEvidenceView;
    return (
      <div className="feature-record-detail">
        <span className="feature-record-detail__avatar"><Phone size={34} weight="duotone" /></span>
        <p className="feature-record-detail__eyebrow">通话记录</p>
        <h1>{call.title}</h1>
        <p>{call.isVideo ? "视频通话" : "语音通话"} · {callDirectionLabel(call.direction)}</p>
        <dl className="evidence-detail-list">
          <div><dt>时间</dt><dd>{formatFullDateTime(call.timestampUtc)}</dd></div>
          <div><dt>时长</dt><dd>{formatDuration(call.durationSeconds)}</dd></div>
          <div><dt>结果</dt><dd>{call.state ?? "未记录"}</dd></div>
          <div><dt>对端标识</dt><dd>{call.peerId ?? "未记录"}</dd></div>
          <div><dt>检材</dt><dd>{source?.specimenName ?? "未选择"}</dd></div>
        </dl>
      </div>
    );
  }
  if (section === "statuses") {
    const status = record as StatusEvidenceView;
    return (
      <div className="feature-record-detail">
        <span className="feature-record-detail__avatar"><CircleNotch size={36} /></span>
        <p className="feature-record-detail__eyebrow">动态发布者</p>
        <h1>{status.title}</h1>
        <p>{formatCount(status.itemCount)} 条动态</p>
        <div className="feature-record-detail__preview">{status.preview ?? "该动态没有可显示的文字摘要。"}</div>
        <dl className="evidence-detail-list">
          <div><dt>发布时间</dt><dd>{formatFullDateTime(status.timestampUtc)}</dd></div>
          <div><dt>失效时间</dt><dd>{formatFullDateTime(status.expiresAtUtc)}</dd></div>
          <div><dt>发布者标识</dt><dd>{status.contactId ?? "未记录"}</dd></div>
        </dl>
      </div>
    );
  }
  if (section === "channels") {
    const channel = record as ChannelEvidenceView;
    return <ChannelMessageFeed channel={channel} />;
  }
  const community = record as CommunityEvidenceView;
  return (
    <div className="feature-record-detail">
      <span className="feature-record-detail__avatar"><UsersThree size={36} /></span>
      <p className="feature-record-detail__eyebrow">社群</p>
      <h1>{community.title}</h1>
      <p>{community.description ?? "该社群没有可显示的说明。"}</p>
      <dl className="evidence-detail-list">
        <div><dt>创建时间</dt><dd>{formatFullDateTime(community.createdAtUtc)}</dd></div>
        <div><dt>子群组</dt><dd>{formatCount(community.childGroups.length)} 个</dd></div>
        <div><dt>社群标识</dt><dd>{community.id}</dd></div>
      </dl>
      {community.childGroups.length === 0 ? null : (
        <section className="community-groups">
          <h2>社群中的群组</h2>
          {community.childGroups.map((group) => (
            <div key={group.id}>
              {group.role === "announcement"
                ? <UsersThree size={20} weight="duotone" />
                : <ChatCircleText size={20} />}
              <span>
                <strong>{group.role === "announcement" ? community.title : group.title}</strong>
                <small>{group.role === "announcement" ? "社群主对话" : "社群群组"} · {group.id}</small>
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function FeatureHero({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="feature-hero">
      <span>{icon}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      <small>只读证据预览</small>
    </div>
  );
}

function FeatureAvailabilityEmpty({
  title,
  availability,
}: {
  title: string;
  availability: SourceFeatureAvailability | null;
}): React.JSX.Element {
  return (
    <EmptyState
      title={title}
      description={availability?.reason ?? (availability?.status === "empty" ? "该检材中没有记录。" : "选择检材后查看记录。")}
    />
  );
}

function featureRecords(
  section: Exclude<WorkspaceSection, "chats">,
  workspace: SourceWorkspaceView | null,
): FeatureRecord[] {
  if (workspace === null || section === "profile") return [];
  return workspace[section];
}

function featureConfiguration(section: Exclude<WorkspaceSection, "chats" | "profile">): {
  title: string;
  emptyTitle: string;
  listLabel: string;
  searchPlaceholder: string | null;
  heroIcon: React.ReactNode;
  heroTitle: string;
  heroDescription: string;
} {
  switch (section) {
    case "calls":
      return {
        title: "通话",
        emptyTitle: "没有通话记录",
        listLabel: "最近通话",
        searchPlaceholder: "搜索通话记录",
        heroIcon: <Phone size={48} weight="duotone" />,
        heroTitle: "通话记录",
        heroDescription: "从左侧选择一条记录查看方向、时间和结果。",
      };
    case "statuses":
      return {
        title: "动态",
        emptyTitle: "没有动态记录",
        listLabel: "动态更新",
        searchPlaceholder: null,
        heroIcon: <CircleNotch size={48} />,
        heroTitle: "动态",
        heroDescription: "从左侧选择发布者查看已采集的动态摘要。",
      };
    case "channels":
      return {
        title: "频道",
        emptyTitle: "没有频道记录",
        listLabel: "已采集频道",
        searchPlaceholder: "搜索频道",
        heroIcon: <Broadcast size={48} />,
        heroTitle: "频道",
        heroDescription: "从左侧选择频道查看说明和已采集更新。",
      };
    case "communities":
      return {
        title: "社群",
        emptyTitle: "没有社群记录",
        listLabel: "已采集社群",
        searchPlaceholder: null,
        heroIcon: <UsersThree size={48} weight="duotone" />,
        heroTitle: "社群",
        heroDescription: "从左侧选择社群查看关联的群组结构。",
      };
  }
}

function featureRecordIcon(
  section: Exclude<WorkspaceSection, "chats" | "profile">,
  record: FeatureRecord,
): React.ReactNode {
  if (section === "calls") {
    return (record as CallEvidenceView).direction === "outgoing"
      ? <PhoneOutgoing size={20} />
      : <PhoneIncoming size={20} />;
  }
  if (section === "statuses") return <CircleNotch size={20} />;
  if (section === "channels") {
    const channel = record as ChannelEvidenceView;
    return (
      <AvatarContent
        url={channel.avatarUrl}
        fallback={<Megaphone size={20} />}
      />
    );
  }
  return <UsersThree size={20} />;
}

function featureRecordDate(record: FeatureRecord): string {
  if ("timestampUtc" in record) return formatCompactDate(record.timestampUtc);
  if ("lastEventAtUtc" in record) return formatCompactDate(record.lastEventAtUtc);
  return formatCompactDate(record.createdAtUtc);
}

function featureRecordSummary(
  section: Exclude<WorkspaceSection, "chats" | "profile">,
  record: FeatureRecord,
): string {
  if (section === "calls") {
    const call = record as CallEvidenceView;
    return `${call.isVideo ? "视频" : "语音"} · ${callDirectionLabel(call.direction)}`;
  }
  if (section === "statuses") return `${formatCount((record as StatusEvidenceView).itemCount)} 条动态`;
  if (section === "channels") return `${formatCount((record as ChannelEvidenceView).eventCount)} 条更新`;
  return `${formatCount((record as CommunityEvidenceView).childGroups.length)} 个群组`;
}

function callDirectionLabel(direction: CallEvidenceView["direction"]): string {
  return direction === "incoming" ? "呼入" : direction === "outgoing" ? "呼出" : "方向未知";
}

function initialFor(value: string): string {
  return value.trim().charAt(0).toLocaleUpperCase("zh-CN") || "?";
}

function AvatarContent({
  url,
  fallback,
}: {
  url: string | null;
  fallback: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <span className="avatar-fallback" aria-hidden="true">{fallback}</span>
      {url === null ? null : (
        <img
          className="captured-avatar"
          src={url}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </>
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

function messageDateKey(value: string | null): string {
  if (value === null) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "未记录";
  const seconds = Math.max(0, Math.trunc(value));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${remainder} 秒`;
  if (minutes > 0) return `${minutes} 分 ${remainder} 秒`;
  return `${remainder} 秒`;
}
