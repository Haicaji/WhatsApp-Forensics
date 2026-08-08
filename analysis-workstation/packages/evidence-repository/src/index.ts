import type {
  CaseSummary,
  Chat,
  ChatQuery,
  CursorPage,
  IntegritySummary,
  Message,
  MessageQuery,
  SearchHit,
  SearchQuery,
  SourceSummary,
} from "@wafc/domain";

/**
 * Stable read-only case evidence boundary shared by the dynamic viewer,
 * future offline export, MCP server, and deterministic Agent tools.
 *
 * Implementations must never mutate a source Evidence Bag. Pagination is
 * cursor-based and callers must not assume that a cursor is portable between
 * repository implementations.
 */
export interface EvidenceRepository {
  getCaseSummary(): Promise<CaseSummary>;
  listSources(): Promise<SourceSummary[]>;
  listChats(query?: ChatQuery): Promise<CursorPage<Chat>>;
  listMessages(query: MessageQuery): Promise<CursorPage<Message>>;
  searchMessages(query: SearchQuery): Promise<CursorPage<SearchHit>>;
  getMessageContext(recordId: string, radius: number): Promise<Message[]>;
  getIntegrity(): Promise<IntegritySummary>;
  close(): Promise<void>;
}

export type {
  CaseSummary,
  Chat,
  ChatQuery,
  CursorPage,
  IntegritySummary,
  Message,
  MessageQuery,
  SearchHit,
  SearchQuery,
  SourceSummary,
};
