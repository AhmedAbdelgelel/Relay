import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/lib/store";
import { MobileNavProvider } from "@/components/shell/MobileNav";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";

export const metadata: Metadata = {
  title: "Relay — LLM Gateway",
  description:
    "OpenAI-compatible gateway with semantic caching: playground, metrics, cache evidence.",
};

export const viewport: Viewport = {
  // Per-theme browser chrome; the theme toggle rewrites these to follow the
  // user's explicit choice.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f8f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

// Pre-paint theme: read `llm-gateway-theme` (light default), set data-theme
// before anything renders so there is no flash. The key is inlined literally:
// importing THEME_KEY from the client store would put a client-reference
// proxy into the script during RSC render. Keep in sync with THEME_KEY in
// lib/store.tsx.
const themeScript = `(function(){try{var t=localStorage.getItem("llm-gateway-theme");if(t!=="light"&&t!=="dark"){t="light"}var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <AppProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-control focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-ink focus:shadow-pop"
          >
            Skip to content
          </a>
          <div className="flex min-h-dvh">
            <MobileNavProvider>
              <Sidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <Topbar />
                <main id="main" tabIndex={-1} className="min-h-0 flex-1">
                  {children}
                </main>
              </div>
            </MobileNavProvider>
          </div>
        </AppProvider>
      </body>
    </html>
  );
}
