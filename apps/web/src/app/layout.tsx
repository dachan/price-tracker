import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Price Tracker",
  description: "Track product prices and receive Discord alerts on changes",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
