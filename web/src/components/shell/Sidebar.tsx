"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import {
  IconCache,
  IconOverview,
  IconPlay,
  IconPlus,
  IconProviders,
  IconRequests,
  IconTrash,
} from "@/components/ui/icons";
import { ConnectionMenu } from "./ConnectionMenu";

const NAV = [
  { href: "/", label: "Overview", Icon: IconOverview },
  { href: "/playground", label: "Playground", Icon: IconPlay },
  { href: "/requests", label: "Requests", Icon: IconRequests },
  { href: "/cache", label: "Cache", Icon: IconCache },
  { href: "/providers", label: "Providers", Icon: IconProviders },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/overview";
  return pathname === href;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { chats, activeChatId, newChat, selectChat, deleteChat } = useAppStore();

  /** Legacy #newChatBtn: start a chat and land on the playground to use it. */
  const startNewChat = () => {
    newChat();
    if (pathname !== "/playground") router.push("/playground");
  };

  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-canvas px-3 py-3 md:flex">
      <Link href="/" className="flex items-center gap-2 px-2 py-1.5">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-[8px] bg-accent text-[13px] font-semibold text-white"
        >
          R
        </span>
        <span className="text-[14px] font-medium text-ink">Relay</span>
        <span className="rounded-pill border border-line px-1.5 py-0.5 text-[10px] text-ink-3">
          v0.1
        </span>
      </Link>

      <nav aria-label="Primary" className="mt-3 space-y-0.5">
        {NAV.map(({ href, label, Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] transition-colors duration-150",
                active
                  ? "bg-active font-medium text-ink"
                  : "text-ink-2 hover:bg-wash hover:text-ink",
              )}
            >
              <Icon size={16} className={cn("shrink-0", active ? "text-accent" : "text-ink-3")} />
              {label}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={startNewChat}
        className="mt-4 flex h-8 w-full items-center justify-center gap-1.5 rounded-control border border-line text-[13px] text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink"
      >
        <IconPlus size={14} />
        New chat
      </button>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {chats.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-ink-3">No chats yet</p>
        ) : (
          <ul className="space-y-0.5">
            {chats.map((chat) => {
              const active = chat.id === activeChatId;
              return (
                <li key={chat.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => selectChat(chat.id)}
                    className={cn(
                      "flex h-8 w-full items-center rounded-control pr-7 pl-2.5 text-left text-[13px] transition-colors duration-150",
                      active
                        ? "bg-active font-medium text-ink"
                        : "text-ink-2 hover:bg-wash hover:text-ink",
                    )}
                  >
                    <span className="truncate">{chat.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteChat(chat.id)}
                    aria-label={`Delete chat ${chat.title}`}
                    className="absolute top-1/2 right-1 hidden size-6 -translate-y-1/2 place-items-center rounded-[6px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-err group-hover:grid group-focus-within:grid"
                  >
                    <IconTrash size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConnectionMenu />
    </aside>
  );
}
