// PROTOTYPE — throwaway. Three structurally different Notification Feeds, switchable via ?variant=.
// Answers "What does the Notification Feed look like in Cadence?"
// (https://github.com/schickm/cohort-005-project/issues/17). Talks to the real Knock feed API
// from the browser with the public key + a server-signed RS256 user token.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowLeft,
  Archive,
  Bell,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  MessageCircleQuestion,
  PlayCircle,
  Receipt,
  Reply,
  Star,
  Ticket,
  UserPlus,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";

export type FeedConfig =
  | {
      ok: true;
      userId: string;
      userToken: string | null;
      tokenError: string | null;
      publicKey: string;
      channelId: string;
    }
  | { ok: false; error: string };

type FeedItem = {
  id: string;
  inserted_at: string;
  read_at: string | null;
  seen_at: string | null;
  archived_at: string | null;
  actors: { id: string; name?: string }[];
  data: { kind?: string; body?: string; url?: string; excerpt?: string } | null;
  blocks: { name: string; rendered?: string }[];
};

type FeedMeta = { unread_count: number; unseen_count: number; total_count: number };

const API = "https://api.knock.app/v1";

// ─── Feed hook ───────────────────────────────────────────────────────────────

export function useKnockFeed(config: FeedConfig | null) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [meta, setMeta] = useState<FeedMeta>({ unread_count: 0, unseen_count: 0, total_count: 0 });
  const [error, setError] = useState<string | null>(config && !config.ok ? config.error : null);

  const headers = useMemo(
    () =>
      config?.ok
        ? {
            Authorization: `Bearer ${config.publicKey}`,
            ...(config.userToken ? { "X-Knock-User-Token": config.userToken } : {}),
            "Content-Type": "application/json",
          }
        : null,
    [config]
  );

  const refresh = useCallback(async () => {
    if (!config?.ok || !headers) return;
    const res = await fetch(
      `${API}/users/${config.userId}/feeds/${config.channelId}?page_size=30`,
      { headers }
    );
    if (!res.ok) {
      setError(`Knock ${res.status}: ${await res.text()}`);
      return;
    }
    const json: { entries: FeedItem[]; meta: FeedMeta } = await res.json();
    setItems(json.entries);
    setMeta(json.meta);
    setError(null);
  }, [config, headers]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000); // prototype: polling, not the realtime socket
    const onEvt = () => void refresh();
    window.addEventListener("knock-feed-refresh", onEvt);
    return () => {
      clearInterval(t);
      window.removeEventListener("knock-feed-refresh", onEvt);
    };
  }, [refresh]);

  const setStatus = useCallback(
    async (ids: string[], status: "seen" | "read" | "unread" | "archived") => {
      if (!headers || ids.length === 0) return;
      const now = new Date().toISOString();
      setItems((prev) =>
        prev
          .map((i) =>
            !ids.includes(i.id)
              ? i
              : status === "seen"
                ? { ...i, seen_at: i.seen_at ?? now }
                : status === "read"
                  ? { ...i, read_at: i.read_at ?? now, seen_at: i.seen_at ?? now }
                  : status === "unread"
                    ? { ...i, read_at: null }
                    : { ...i, archived_at: now }
          )
          .filter((i) => !i.archived_at)
      );
      await fetch(`${API}/messages/batch/${status}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message_ids: ids }),
      });
      await refresh();
    },
    [headers, refresh]
  );

  const tokenError = config?.ok ? config.tokenError : null;
  return { items, meta, error, tokenError, refresh, setStatus };
}

type Feed = ReturnType<typeof useKnockFeed>;

// ─── Shared bits (row content only — each variant owns its layout) ───────────

const KIND: Record<string, { icon: React.ReactNode; group: string }> = {
  refund_requested: { icon: <Receipt className="size-4" />, group: "Refunds" },
  refund_decided: { icon: <Receipt className="size-4" />, group: "Refunds" },
  enrollment: { icon: <UserPlus className="size-4" />, group: "Your courses" },
  seat_claimed: { icon: <Ticket className="size-4" />, group: "Your team" },
  new_question: { icon: <MessageCircleQuestion className="size-4" />, group: "Discussions" },
  comment_reply: { icon: <Reply className="size-4" />, group: "Discussions" },
  new_rating: { icon: <Star className="size-4" />, group: "Your courses" },
  new_lesson: { icon: <PlayCircle className="size-4" />, group: "Your courses" },
};

function kindOf(item: FeedItem) {
  return KIND[item.data?.kind ?? ""] ?? { icon: <Bell className="size-4" />, group: "Other" };
}

function bodyOf(item: FeedItem) {
  return item.data?.body ?? item.blocks.find((b) => b.name === "body")?.rendered ?? "(no body)";
}

function urlOf(item: FeedItem) {
  return item.data?.url ?? item.blocks.find((b) => b.name === "action_url")?.rendered ?? null;
}

/** Renders the **bold** spans in a Notification body. */
function Body({ text }: { text: string }) {
  const parts = text.replace(/<[^>]+>/g, "").split("**");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-foreground">
            {p}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Badge({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold leading-5 text-white",
        className
      )}
    >
      {n > 9 ? "9+" : n}
    </span>
  );
}

function FeedError({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="m-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">{error}</div>;
}

function Empty() {
  return (
    <div className="p-8 text-center text-sm text-muted-foreground">
      You're all caught up.
      <div className="mt-1 text-xs">(Use “Seed” in the prototype bar to send some.)</div>
    </div>
  );
}

// ─── Variant A: bell in the sidebar header → popover; seen on open, read on click ──

export const variantAName = "Bell popover";

export function VariantABell({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void feed.setStatus(feed.items.filter((i) => !i.seen_at).map((i) => i.id), "seen");
  }

  return (
    <div className="relative">
      <button
        onClick={toggle}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        <Badge n={feed.meta.unseen_count} className="absolute -right-1 -top-1" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-full top-0 z-50 ml-2 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="font-semibold">Notifications</span>
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => feed.setStatus(feed.items.filter((i) => !i.read_at).map((i) => i.id), "read")}
              >
                Mark all as read
              </button>
            </div>
            <FeedError error={feed.error} />
            <div className="max-h-[28rem] divide-y overflow-y-auto">
              {feed.items.length === 0 && <Empty />}
              {feed.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    void feed.setStatus([item.id], "read");
                    setOpen(false);
                    const url = urlOf(item);
                    if (url) navigate(url);
                  }}
                  className={cn(
                    "flex w-full gap-3 px-4 py-3 text-left text-sm hover:bg-accent",
                    !item.read_at && "bg-primary/5"
                  )}
                >
                  <span className="mt-0.5 text-muted-foreground">{kindOf(item).icon}</span>
                  <span className="flex-1 text-muted-foreground">
                    <Body text={bodyOf(item)} />
                    {item.data?.excerpt && (
                      <span className="mt-1 block truncate text-xs italic">“{item.data.excerpt}”</span>
                    )}
                    <span className="mt-1 block text-xs">{ago(item.inserted_at)}</span>
                  </span>
                  {!item.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Variant B: nav item → right-hand drawer inbox; explicit read/unread/archive ──

export const variantBName = "Drawer inbox";

export function VariantBNavItem({ feed, onOpen }: { feed: Feed; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <BellRing className="size-4" />
      <span className="flex-1 text-left">Notifications</span>
      <Badge n={feed.meta.unread_count} />
    </button>
  );
}

export function VariantBDrawer({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const navigate = useNavigate();
  const shown = feed.items.filter((i) => tab === "all" || !i.read_at);
  const today = new Date().toDateString();
  const groups: [string, FeedItem[]][] = [
    ["Today", shown.filter((i) => new Date(i.inserted_at).toDateString() === today)],
    ["Earlier", shown.filter((i) => new Date(i.inserted_at).toDateString() !== today)],
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-[28rem] flex-col border-l bg-background shadow-2xl">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <h2 className="flex-1 text-lg font-semibold">Notifications</h2>
          <button
            className="rounded-md px-2 py-1 text-xs hover:bg-accent"
            onClick={() => feed.setStatus(feed.items.filter((i) => !i.read_at).map((i) => i.id), "read")}
          >
            <Check className="mr-1 inline size-3" />
            Mark all read
          </button>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex gap-1 border-b px-5 py-2 text-sm">
          {(["unread", "all"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("rounded-full px-3 py-1 capitalize", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
            >
              {t} {t === "unread" && `(${feed.meta.unread_count})`}
            </button>
          ))}
        </div>
        <FeedError error={feed.error} />
        <div className="flex-1 overflow-y-auto">
          {shown.length === 0 && <Empty />}
          {groups.map(
            ([label, list]) =>
              list.length > 0 && (
                <section key={label}>
                  <div className="sticky top-0 bg-muted px-5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </div>
                  {list.map((item) => (
                    <div key={item.id} className="group flex items-start gap-3 border-b px-5 py-4">
                      <div
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-full",
                          item.read_at ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                        )}
                      >
                        {kindOf(item).icon}
                      </div>
                      <button
                        className="flex-1 text-left text-sm text-muted-foreground"
                        onClick={() => {
                          void feed.setStatus([item.id], "read");
                          onClose();
                          const url = urlOf(item);
                          if (url) navigate(url);
                        }}
                      >
                        <Body text={bodyOf(item)} />
                        {item.data?.excerpt && (
                          <span className="mt-2 block rounded border-l-2 bg-muted/50 px-2 py-1 text-xs">{item.data.excerpt}</span>
                        )}
                        <span className="mt-1 block text-xs">
                          {kindOf(item).group} · {ago(item.inserted_at)}
                        </span>
                      </button>
                      <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100">
                        <button
                          title={item.read_at ? "Mark unread" : "Mark read"}
                          className="rounded p-1 hover:bg-accent"
                          onClick={() => feed.setStatus([item.id], item.read_at ? "unread" : "read")}
                        >
                          <CircleDot className="size-4" />
                        </button>
                        <button title="Archive" className="rounded p-1 hover:bg-accent" onClick={() => feed.setStatus([item.id], "archived")}>
                          <Archive className="size-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              )
          )}
        </div>
      </aside>
    </>
  );
}

// ─── Variant C: sidebar takes over; grouped by area; everything read on open ──

export const variantCName = "Sidebar takeover";

export function VariantCNavItem({ feed, onOpen }: { feed: Feed; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <span className="relative">
        <Bell className="size-4" />
        {feed.meta.unread_count > 0 && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-600" />}
      </span>
      <span className="flex-1 text-left">Notifications</span>
      {feed.meta.unread_count > 0 && <span className="text-xs text-sidebar-foreground/50">{feed.meta.unread_count} new</span>}
    </button>
  );
}

export function VariantCPanel({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const navigate = useNavigate();
  // "new this visit" = read during the open that just happened; snapshot on mount
  const [newIds] = useState(() => new Set(feed.items.filter((i) => !i.read_at).map((i) => i.id)));
  useEffect(() => {
    void feed.setStatus([...newIds], "read"); // opening the panel reads everything
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const groups = new Map<string, FeedItem[]>();
  for (const item of feed.items) {
    const g = kindOf(item).group;
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
        <button onClick={onClose} className="rounded p-1 hover:bg-sidebar-accent">
          <ArrowLeft className="size-4" />
        </button>
        <span className="text-sm font-semibold">Notifications</span>
      </div>
      <FeedError error={feed.error} />
      <div className="flex-1 overflow-y-auto p-2">
        {feed.items.length === 0 && <Empty />}
        {[...groups.entries()].map(([group, list]) => (
          <div key={group} className="mb-3">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              {group}
            </div>
            {list.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  const url = urlOf(item);
                  if (url) navigate(url);
                }}
                className="flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent"
              >
                <span className="mt-0.5">{kindOf(item).icon}</span>
                <span className="flex-1">
                  <Body text={bodyOf(item)} />
                  <span className="ml-1 text-sidebar-foreground/40">{ago(item.inserted_at)}</span>
                </span>
                {newIds.has(item.id) && <span className="mt-1 text-[10px] font-bold uppercase text-red-600">new</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Floating switcher (prototype only) ──────────────────────────────────────

export const VARIANTS = [
  { key: "A", name: variantAName },
  { key: "B", name: variantBName },
  { key: "C", name: variantCName },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

export function PrototypeSwitcher({
  current,
  onChange,
  feed,
}: {
  current: VariantKey;
  onChange: (v: VariantKey) => void;
  feed: Feed;
}) {
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const idx = VARIANTS.findIndex((v) => v.key === current);

  const step = useCallback(
    (d: number) => onChange(VARIANTS[(idx + d + VARIANTS.length) % VARIANTS.length].key),
    [idx, onChange]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (t instanceof HTMLElement && (t.closest("input, textarea, [contenteditable]") !== null)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  async function seed() {
    setSeeding(true);
    setSeedMsg(null);
    const res = await fetch("/api/prototype-notifications-seed", { method: "POST" });
    setSeeding(false);
    setSeedMsg(res.ok ? "sent" : await res.text());
    window.dispatchEvent(new Event("knock-feed-refresh"));
    setTimeout(() => window.dispatchEvent(new Event("knock-feed-refresh")), 1500);
  }

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 shadow-xl ring-2 ring-fuchsia-500">
      <button onClick={() => step(-1)} className="rounded-full p-1 hover:bg-zinc-700">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-40 text-center">
        {current} ({VARIANTS[idx].name})
      </span>
      <button onClick={() => step(1)} className="rounded-full p-1 hover:bg-zinc-700">
        <ChevronRight className="size-4" />
      </button>
      <span className="text-zinc-400" title="Knock feed meta">
        unseen {feed.meta.unseen_count} · unread {feed.meta.unread_count} · total {feed.meta.total_count}
      </span>
      <button onClick={seed} disabled={seeding} className="rounded-full bg-fuchsia-600 px-2 py-0.5 hover:bg-fuchsia-500 disabled:opacity-50">
        {seeding ? "Seeding…" : "Seed"}
      </button>
      {feed.tokenError && (
        <span className="max-w-48 truncate text-amber-300" title={feed.tokenError}>
          ⚠ unsigned
        </span>
      )}
      {seedMsg && seedMsg !== "sent" && (
        <span className="max-w-64 truncate text-red-300" title={seedMsg}>
          {seedMsg}
        </span>
      )}
    </div>
  );
}
