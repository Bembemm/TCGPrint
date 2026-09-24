import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TCGPrint",
  description: "Local-first TCG card print preparation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
