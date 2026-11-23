import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnimeCartel Supplier Intelligence",
  description: "Category-based supplier price comparison with manual, reversible merges.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
