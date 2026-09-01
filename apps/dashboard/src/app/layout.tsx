import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Finance Agent OS — Dashboard",
  description: "Real-time trading dashboard: market, portfolio, risk, agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Tailwind via CDN — zero build step, keeps dashboard runnable without postcss setup */}
        <script src="https://cdn.tailwindcss.com"></script>
        <script
          // tailwind config override for dark finance theme
          dangerouslySetInnerHTML={{
            __html: `
              if (window.tailwind) {
                window.tailwind.config = {
                  theme: {
                    extend: {
                      colors: {
                        bg: '#0a0a0f',
                        panel: 'rgba(255,255,255,0.04)',
                      }
                    }
                  }
                }
              }
            `,
          }}
        />
      </head>
      <body className="min-h-screen bg-[#0a0a0f] text-zinc-100 antialiased">
        {/* Top nav — duplicated in page.tsx header for standalone SEO, but keep global bg */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 40,
            backdropFilter: "blur(12px)",
            background: "rgba(10,10,15,0.8)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-emerald-400 flex items-center justify-center font-black text-xs">
                FA
              </div>
              <div>
                <div className="text-sm font-bold tracking-tight leading-none">Finance Agent OS</div>
                <div className="text-[11px] opacity-60">Dashboard • SSE :4132 • Next 14</div>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-xs">
              <span className="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">● live</span>
              <a
                href="http://localhost:4132/api/health"
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10"
              >
                API health ↗
              </a>
            </div>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
