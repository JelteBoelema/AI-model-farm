import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Toaster } from "sonner";
import { THEME_SCRIPT } from "@/components/layout/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Creator Farm", template: "%s · Creator Farm" },
  description: "Control centre for AI creator production, publishing, analytics and costs.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
