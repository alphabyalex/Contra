'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { depositToBasket } from '../_lib/deposit-client';

export function DepositForm({ basketId, onConfirmed }: { basketId: string; onConfirmed?: (sig: string) => void }) {
  const wallet = useWallet();
  const [amount, setAmount] = useState('100');
  const [leverage, setLeverage] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!wallet.publicKey) {
    return (
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
        <div
          style={{
            fontSize: 10,
            color: '#9B9B9B',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 12,
          }}
        >
          Connect wallet to deposit
        </div>
        <WalletMultiButton />
      </div>
    );
  }

  async function submit() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter a positive USDC amount');
      if (leverage !== 1) throw new Error('Leverage paths land in the next build pass — please use 1x for now.');
      const { signature } = await depositToBasket({ wallet, basketId, amountUsdc: amt });
      setMsg(`Confirmed: ${signature.slice(0, 12)}…`);
      onConfirmed?.(signature);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }} >
      <div className="space-y-4">
        <div>
          <div style={labelStyle}>USDC amount</div>
          <input
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            style={{
              width: '100%',
              background: '#F0F0EE',
              border: '1px solid #E5E5E3',
              borderRadius: 3,
              padding: '10px 12px',
              fontSize: 14,
              color: '#0A0A0A',
              fontFamily: '"IBM Plex Mono", monospace',
            }}
          />
        </div>

        <div>
          <div style={labelStyle}>Leverage</div>
          <div className="flex gap-2">
            {[1, 2, 3].map((n) => {
              const active = leverage === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setLeverage(n as 1 | 2 | 3)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    fontSize: 13,
                    fontFamily: '"IBM Plex Mono", monospace',
                    border: active ? '1px solid #1A56DB' : '1px solid #E5E5E3',
                    color: active ? '#1A56DB' : '#6B6B6B',
                    background: active ? '#EBF0FF' : '#FFFFFF',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  {n}x
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{
            width: '100%',
            background: '#1A56DB',
            color: '#FFFFFF',
            padding: '10px 0',
            fontSize: 13,
            fontWeight: 500,
            borderRadius: 3,
            border: 'none',
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? 'Confirming…' : 'Open short position'}
        </button>

        {msg && <div style={{ color: '#00875A', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', wordBreak: 'break-all' }}>{msg}</div>}
        {err && <div style={{ color: '#CC2936', fontSize: 12 }}>{err}</div>}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
  fontFamily: '"DM Sans", sans-serif',
};
