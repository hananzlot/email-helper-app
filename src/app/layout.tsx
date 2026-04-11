import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearbox — Your Inbox Command Center",
  description: "Triage, prioritize, and manage your Gmail inbox with AI-powered intelligence.",
  icons: {
    icon: '/clearbox-favicon.svg',
    apple: '/clearbox-logo.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
