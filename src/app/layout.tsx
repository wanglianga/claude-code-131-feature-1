import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "悦安月子中心 · 护理与探访平台",
  description: "月子中心产妇护理计划与家属探访平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
