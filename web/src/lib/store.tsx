"use client";

/**
 * Global client store: connection, chat stack, session stats, last IO and
 * health/metrics polling. Built on React context + useReducer, no libraries.
 *
 * SSR-safe: nothing here reads localStorage during render. The persisted
 * state is loaded in a mount effect (`hydrate`) and written back by effects
 * once hydrated, so server HTML and the first client render always match.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { connectionFromLocationHash, GatewayClient, GatewayError, loadConnection, saveConnection } from "./gateway";
import {
  EMPTY_STATS,
  type ChatMessage,
  type ChatRecord,
  type Connection,
  type Evidence,
  type HealthInfo,
  type LastIO,
  type MetricsSnapshot,
  type SessionStats,
} from "./types";

/** Shared with the pre-paint theme script in app/layout.tsx — keep in sync. */
export const THEME_KEY = "llm-gateway-theme";
export const CHATS_KEY = "llm-gateway-chats-v1";
/** Settings → Advanced: reveals technical surfaces in the playground. */
export const ADVANCED_KEY = "llm-gateway-advanced";

export const MAX_CHATS = 30;
export const DEFAULT_CHAT_TITLE = "New chat";
const POLL_INTERVAL_MS = 30_000;

export type ConnectionStatus = "checking" | "online" | "offline" | "error";

interface PersistedChats {
  activeChatId: string | null;
  chats: ChatRecord[];
}

interface AppState {
  hydrated: boolean;
  connection: Connection;
  /** Settings → Advanced toggle (persisted): show technical details. */
  advanced: boolean;
  chats: ChatRecord[];
  activeChatId: string | null;
  stats: SessionStats;
  lastIO: LastIO | null;
  health: HealthInfo | null;
  metrics: MetricsSnapshot | null;
  status: ConnectionStatus;
}

type Action =
  | { type: "hydrate"; persisted: PersistedChats; connection: Connection; advanced: boolean }
  | { type: "connection"; connection: Connection }
  | { type: "advanced"; advanced: boolean }
  | { type: "new-chat"; id: string; at: string }
  | { type: "select-chat"; id: string }
  | { type: "delete-chat"; id: string }
  | { type: "append-message"; chatId: string; message: ChatMessage; at: string }
  | { type: "update-message"; chatId: string; messageId: string; patch: Partial<ChatMessage> }
  | { type: "clear-chat"; chatId: string }
  | { type: "record-stats"; input: StatsInput }
  | { type: "reset-stats" }
  | { type: "last-io"; lastIO: LastIO | null }
  | { type: "health-ok"; health: HealthInfo }
  | { type: "poll-failed"; kind: "offline" | "error" }
  | { type: "metrics-ok"; metrics: MetricsSnapshot };

const INITIAL_STATE: AppState = {
  hydrated: false,
  connection: { baseUrl: "", apiKey: "" },
  advanced: false,
  chats: [],
  activeChatId: null,
  stats: EMPTY_STATS,
  lastIO: null,
  health: null,
  metrics: null,
  status: "checking",
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

export function newId(prefix = "c"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Title = first 42 chars of the first user message (ellipsis when cut). */
export function chatTitleFrom(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed || DEFAULT_CHAT_TITLE;
}

function sortChats(chats: ChatRecord[]): ChatRecord[] {
  return [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function loadPersistedChats(): PersistedChats {
  if (typeof window === "undefined") return { activeChatId: null, chats: [] };
  try {
    const raw = window.localStorage.getItem(CHATS_KEY);
    if (!raw) return { activeChatId: null, chats: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedChats> | null;
    const chats = Array.isArray(parsed?.chats)
      ? parsed.chats.filter(
          (chat): chat is ChatRecord =>
            Boolean(chat) &&
            typeof chat.id === "string" &&
            typeof chat.title === "string" &&
            Array.isArray(chat.messages) &&
            typeof chat.updatedAt === "string",
        )
      : [];
    const sorted = sortChats(chats).slice(0, MAX_CHATS);
    const activeChatId =
      typeof parsed?.activeChatId === "string" && sorted.some((c) => c.id === parsed.activeChatId)
        ? parsed.activeChatId
        : (sorted[0]?.id ?? null);
    return { activeChatId, chats: sorted };
  } catch {
    return { activeChatId: null, chats: [] };
  }
}

function savePersistedChats(persisted: PersistedChats): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHATS_KEY, JSON.stringify(persisted));
  } catch {
    /* storage disabled: chats stay in memory for this session */
  }
}

function loadAdvanced(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAdvanced(advanced: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADVANCED_KEY, advanced ? "1" : "0");
  } catch {
    /* storage disabled: the toggle stays in memory for this session */
  }
}

/* ── session stats ───────────────────────────────────────────────────────── */

export interface StatsTokens {
  promptTokens?: number;
  completionTokens?: number;
  estimated?: boolean;
}

export interface StatsOptions {
  ttftMs?: number;
  chunks?: number;
  error?: string | null;
}

export interface StatsInput {
  evidence: Evidence | null;
  tokens: StatsTokens | null;
  latencyMs: number | null;
  options: StatsOptions;
}

/**
 * Pure session-stats fold. Fixes the legacy verdict bug: HIT and
 * SEMANTIC_HIT both count as hits + reused tokens (SEMANTIC_HIT additionally
 * increments semanticHits); DISABLED and BYPASS are their own buckets;
 * errors are counted separately and never hide a verdict.
 */
export function applyStats(stats: SessionStats, input: StatsInput): SessionStats {
  const { evidence, tokens, latencyMs, options } = input;
  const next: SessionStats = { ...stats, requests: stats.requests + 1 };
  const verdict = evidence?.cache ?? null;

  if (verdict === "HIT" || verdict === "SEMANTIC_HIT") {
    next.hits += 1;
    next.reusedTokens += (tokens?.promptTokens ?? 0) + (tokens?.completionTokens ?? 0);
  } else if (verdict === "MISS") {
    next.misses += 1;
  } else if (verdict === "DISABLED") {
    next.disabled += 1;
  } else {
    next.bypassed += 1;
  }
  if (verdict === "SEMANTIC_HIT") next.semanticHits += 1;

  if (options.error) next.errors += 1;
  next.promptTokens += tokens?.promptTokens ?? 0;
  next.completionTokens += tokens?.completionTokens ?? 0;
  if (tokens?.estimated) next.estimated = true;
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    next.latencyMsTotal += Math.max(0, latencyMs);
  }
  if (typeof options.ttftMs === "number" && Number.isFinite(options.ttftMs)) {
    next.ttftMsTotal += Math.max(0, options.ttftMs);
    next.ttftCount += 1;
  }
  if (typeof options.chunks === "number" && Number.isFinite(options.chunks)) {
    next.chunks += Math.max(0, options.chunks);
  }
  return next;
}

/** verdicts that reached a cache decision (hits + misses). */
export function sessionDecided(stats: SessionStats): number {
  return stats.hits + stats.misses;
}

/** hits / decided as a ratio in [0, 1]; null before any decision. */
export function sessionHitRate(stats: SessionStats): number | null {
  const decided = sessionDecided(stats);
  return decided > 0 ? stats.hits / decided : null;
}

export function sessionTotalTokens(stats: SessionStats): number {
  return stats.promptTokens + stats.completionTokens;
}

/* ── reducer ─────────────────────────────────────────────────────────────── */

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        hydrated: true,
        connection: action.connection,
        advanced: action.advanced,
        chats: action.persisted.chats,
        activeChatId: action.persisted.activeChatId,
      };
    case "advanced":
      return { ...state, advanced: action.advanced };
    case "connection": {
      const changed =
        action.connection.baseUrl !== state.connection.baseUrl ||
        action.connection.apiKey !== state.connection.apiKey;
      return {
        ...state,
        connection: action.connection,
        status: changed ? "checking" : state.status,
      };
    }
    case "new-chat": {
      const chat: ChatRecord = {
        id: action.id,
        title: DEFAULT_CHAT_TITLE,
        messages: [],
        updatedAt: action.at,
      };
      return {
        ...state,
        chats: [chat, ...state.chats].slice(0, MAX_CHATS),
        activeChatId: chat.id,
      };
    }
    case "select-chat":
      return state.chats.some((c) => c.id === action.id)
        ? { ...state, activeChatId: action.id }
        : state;
    case "delete-chat": {
      const chats = state.chats.filter((c) => c.id !== action.id);
      const activeChatId =
        state.activeChatId === action.id ? (chats[0]?.id ?? null) : state.activeChatId;
      return { ...state, chats, activeChatId };
    }
    case "append-message": {
      const chat = state.chats.find((c) => c.id === action.chatId);
      if (!chat) return state;
      const retitle =
        chat.title === DEFAULT_CHAT_TITLE && action.message.role === "user" && action.message.text;
      const updated: ChatRecord = {
        ...chat,
        title: retitle ? chatTitleFrom(action.message.text) : chat.title,
        messages: [...chat.messages, action.message],
        updatedAt: action.at,
      };
      return {
        ...state,
        chats: [updated, ...state.chats.filter((c) => c.id !== chat.id)],
      };
    }
    case "update-message": {
      let touched = false;
      const chats = state.chats.map((chat) => {
        if (!chat.messages.some((m) => m.id === action.messageId)) return chat;
        touched = true;
        return {
          ...chat,
          messages: chat.messages.map((m) =>
            m.id === action.messageId ? { ...m, ...action.patch } : m,
          ),
        };
      });
      return touched ? { ...state, chats } : state;
    }
    case "clear-chat": {
      const chats = state.chats.map((chat) =>
        chat.id === action.chatId ? { ...chat, messages: [] } : chat,
      );
      return { ...state, chats };
    }
    case "record-stats":
      return { ...state, stats: applyStats(state.stats, action.input) };
    case "reset-stats":
      return { ...state, stats: EMPTY_STATS };
    case "last-io":
      return { ...state, lastIO: action.lastIO };
    case "health-ok":
      return { ...state, health: action.health, status: "online" };
    case "poll-failed":
      return { ...state, status: action.kind };
    case "metrics-ok":
      return { ...state, metrics: action.metrics };
  }
}

/* ── context ─────────────────────────────────────────────────────────────── */

export interface AppStore {
  /** localStorage hydration finished (drafts/persisted UI can rely on it). */
  hydrated: boolean;
  connection: Connection;
  setConnection: (connection: Connection) => void;
  /** Settings → Advanced: show technical details in the playground. */
  advanced: boolean;
  setAdvanced: (advanced: boolean) => void;
  chats: ChatRecord[];
  activeChatId: string | null;
  activeChat: ChatRecord | null;
  newChat: () => string;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  appendMessage: (chatId: string, message: ChatMessage) => void;
  updateMessage: (chatId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  clearChat: (chatId: string) => void;
  stats: SessionStats;
  recordStats: (
    evidence: Evidence | null,
    tokens: StatsTokens | null,
    latencyMs: number | null,
    options?: StatsOptions,
  ) => void;
  resetStats: () => void;
  lastIO: LastIO | null;
  setLastIO: (lastIO: LastIO | null) => void;
  health: HealthInfo | null;
  metrics: MetricsSnapshot | null;
  status: ConnectionStatus;
  /** True once a poll has failed (offline badge surfaces this). */
  offline: boolean;
  /** Re-poll /health and /metrics right now. */
  refresh: () => void;
}

const AppContext = createContext<AppStore | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const pollRef = useRef<(() => void) | null>(null);

  // One mount-time hydration pass: never read localStorage during render.
  // A demo/handoff link may carry the connection in the URL fragment
  // (`#apiKey=lg_…`); consume it once, persist it, and drop it from the URL.
  useEffect(() => {
    const fromHash =
      typeof window !== "undefined" ? connectionFromLocationHash(window.location.hash) : null;
    if (fromHash) {
      saveConnection(fromHash);
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        /* history API unavailable: the fragment simply stays visible */
      }
    }
    dispatch({
      type: "hydrate",
      persisted: loadPersistedChats(),
      connection: fromHash ?? loadConnection(),
      advanced: loadAdvanced(),
    });
  }, []);

  // Write-through persistence, gated on hydration so the initial empty state
  // can never clobber storage.
  useEffect(() => {
    if (state.hydrated) saveConnection(state.connection);
  }, [state.hydrated, state.connection]);
  useEffect(() => {
    if (state.hydrated) saveAdvanced(state.advanced);
  }, [state.hydrated, state.advanced]);
  useEffect(() => {
    if (state.hydrated) {
      savePersistedChats({ activeChatId: state.activeChatId, chats: state.chats });
    }
  }, [state.hydrated, state.activeChatId, state.chats]);

  // Single polling effect: /health + /metrics every 30 s and on connection
  // change. Failures keep the last snapshot (offline-safe, inventory §1).
  const connection = state.connection;
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      const client = new GatewayClient(connection);
      try {
        const health = await client.health(controller.signal);
        if (!cancelled) dispatch({ type: "health-ok", health });
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: "poll-failed",
            kind: error instanceof GatewayError ? "error" : "offline",
          });
        }
      }
      try {
        const metrics = await client.metrics(controller.signal);
        if (!cancelled) dispatch({ type: "metrics-ok", metrics });
      } catch {
        /* keep the last known snapshot */
      }
    };
    pollRef.current = () => {
      void run();
    };
    void run();
    const interval = window.setInterval(() => {
      void run();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      pollRef.current = null;
    };
  }, [connection]);

  const setConnection = useCallback((next: Connection) => {
    dispatch({ type: "connection", connection: next });
  }, []);
  const setAdvanced = useCallback((advanced: boolean) => {
    dispatch({ type: "advanced", advanced });
  }, []);
  const newChat = useCallback((): string => {
    const id = newId("chat");
    dispatch({ type: "new-chat", id, at: new Date().toISOString() });
    return id;
  }, []);
  const selectChat = useCallback((id: string) => {
    dispatch({ type: "select-chat", id });
  }, []);
  const deleteChat = useCallback((id: string) => {
    dispatch({ type: "delete-chat", id });
  }, []);
  const appendMessage = useCallback((chatId: string, message: ChatMessage) => {
    dispatch({ type: "append-message", chatId, message, at: new Date().toISOString() });
  }, []);
  const updateMessage = useCallback(
    (chatId: string, messageId: string, patch: Partial<ChatMessage>) => {
      dispatch({ type: "update-message", chatId, messageId, patch });
    },
    [],
  );
  const clearChat = useCallback((chatId: string) => {
    dispatch({ type: "clear-chat", chatId });
  }, []);
  const recordStats = useCallback(
    (
      evidence: Evidence | null,
      tokens: StatsTokens | null,
      latencyMs: number | null,
      options: StatsOptions = {},
    ) => {
      dispatch({ type: "record-stats", input: { evidence, tokens, latencyMs, options } });
    },
    [],
  );
  const resetStats = useCallback(() => {
    dispatch({ type: "reset-stats" });
  }, []);
  const setLastIO = useCallback((lastIO: LastIO | null) => {
    dispatch({ type: "last-io", lastIO });
  }, []);
  const refresh = useCallback(() => {
    pollRef.current?.();
  }, []);

  const activeChat = useMemo(
    () => state.chats.find((chat) => chat.id === state.activeChatId) ?? null,
    [state.chats, state.activeChatId],
  );

  const value = useMemo<AppStore>(
    () => ({
      hydrated: state.hydrated,
      connection: state.connection,
      setConnection,
      advanced: state.advanced,
      setAdvanced,
      chats: state.chats,
      activeChatId: state.activeChatId,
      activeChat,
      newChat,
      selectChat,
      deleteChat,
      appendMessage,
      updateMessage,
      clearChat,
      stats: state.stats,
      recordStats,
      resetStats,
      lastIO: state.lastIO,
      setLastIO,
      health: state.health,
      metrics: state.metrics,
      status: state.status,
      offline: state.status === "offline" || state.status === "error",
      refresh,
    }),
    [
      state,
      activeChat,
      setConnection,
      setAdvanced,
      newChat,
      selectChat,
      deleteChat,
      appendMessage,
      updateMessage,
      clearChat,
      recordStats,
      resetStats,
      setLastIO,
      refresh,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(AppContext);
  if (!store) throw new Error("useAppStore must be used within <AppProvider>");
  return store;
}
