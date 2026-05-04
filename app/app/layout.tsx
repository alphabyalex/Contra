import type { Metadata } from 'next';
import './globals.css';
import { ContraWalletProvider } from './_lib/wallet';
import { ContraStateProvider } from './_lib/state';
import { Logo } from './_components/Logo';
import { NavTabs } from './_components/NavTabs';
import { ConnectButton } from './_components/ConnectButton';
import { PortfolioCta } from './_components/PortfolioCta';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'CONTRA — Bet Against the Obvious',
  description: 'Solana-native short-basket protocol for overpriced prediction-market longshots.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@200;300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ background: '#F7F7F5' }}>
        <ContraWalletProvider>
          <ContraStateProvider>
            <header
              className="sticky top-0 z-30 bg-white"
              style={{ borderBottom: '1px solid #E5E5E3', height: 56 }}
            >
              <div className="max-w-[1400px] mx-auto h-full px-6 flex items-center justify-between">
                <Link href="/" className="flex items-center">
                  <Logo size={20} tagline />
                </Link>
                <NavTabs />
                <div className="flex items-center gap-3">
                  <PortfolioCta />
                  <ConnectButton />
                </div>
              </div>
            </header>

            <main>{children}</main>

            {/* Slim disclaimer footer — present on every page. */}
            <footer
              style={{
                height: 36,
                background: '#F7F7F5',
                borderTop: '1px solid #E5E5E3',
              }}
            >
              <div
                className="max-w-[1400px] mx-auto h-full px-6 flex items-center justify-between"
                style={{
                  fontSize: 11,
                  color: '#6B6B6B',
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                }}
              >
                <span>Devnet · Not financial advice · Use at your own risk</span>
                <div className="flex items-center gap-6">
                  <Link
                    href="/about?tab=disclaimer"
                    style={{
                      color: '#1A56DB',
                      fontSize: 11,
                      fontWeight: 500,
                      textDecoration: 'none',
                    }}
                  >
                    Full Risk Disclosure →
                  </Link>
                  <span style={{ color: '#9B9B9B' }}>Contra Protocol · Solana Devnet · 2026</span>
                </div>
              </div>
            </footer>
          </ContraStateProvider>
        </ContraWalletProvider>
      </body>
    </html>
  );
}
