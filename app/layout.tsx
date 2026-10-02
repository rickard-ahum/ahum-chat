import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ahum chatt",
  description: "Hitta program och moduler från Ahum som passar det du vill ha hjälp med.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <head>
        {/* Typsnitten från ahum.se (Satoshi och Clash Display) via Fontshare. */}
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&f[]=clash-display@500,600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
