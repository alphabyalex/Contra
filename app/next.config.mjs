/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Wallet adapter packages ship as CJS — Next needs them transpiled.
  transpilePackages: [
    '@solana/wallet-adapter-base',
    '@solana/wallet-adapter-phantom',
    '@solana/wallet-adapter-react',
    '@solana/wallet-adapter-react-ui',
  ],
};

export default config;
