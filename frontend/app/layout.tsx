import { APP_NAME } from '@/lib/brand';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: `${APP_NAME} · Dashboard`,
  description: `${APP_NAME} — Ad Performance`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
