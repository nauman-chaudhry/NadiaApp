import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nadia Dashboard',
  description: 'Seven Sphere Media — Ad Performance',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
