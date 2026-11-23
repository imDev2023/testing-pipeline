import "../theme.css";
import "../base.css";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { BRAND } from "@/brand";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { isChosenTheme, THEME_COOKIE } from "@/theme";

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: "Every market and strategy on Pipeline, with what was read from the chain and measured. Devnet only.",
  // Devnet carries test tokens only, so nothing here is for search engines.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const chosen = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isChosenTheme(chosen) ? chosen : "device";
  return (
    // The theme control changes `data-theme` after hydration on purpose; that is not a mismatch.
    <html lang="en" data-theme={theme === "device" ? undefined : theme} suppressHydrationWarning>
      <body>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter theme={theme} />
      </body>
    </html>
  );
}
