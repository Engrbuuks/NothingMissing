import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  icons: {
    icon: '/favicon.png',
    apple: '/brand/mark-180.png',
  },
  title: 'Nothing Missing',
  description:
    'Asset and inventory management for companies running depots, branches and site offices.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Fonts come from Google's CDN rather than next/font. next/font is the
          better option — self-hosted, no third-party request, no layout shift —
          but it downloads the files at build time, which needs network access
          during the build. Worth switching to once you can verify a build with
          that access; the CSS variables below already carry system fallbacks,
          so nothing breaks if the CDN is unreachable.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
