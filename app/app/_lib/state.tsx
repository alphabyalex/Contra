'use client';

/**
 * Single reducer for all frontend state — portfolio rows, USDC balance,
 * recent deposit/redeem confirmations. Pages and components subscribe via
 * `useContraState()` instead of holding their own copies.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { api } from './api';

interface Position {
  id: string;
  basket_id: string;
  basket: { id: string; name: string; status: string } | null;
  tokens_held: number;
  usdc_deposited: number;
  entry_nav?: number;
  current_nav: number;
  current_value_usdc: number;
  pnl_usdc: number;
  pnl_pct: number;
  redeemable: boolean;
}

interface State {
  walletAddress: string | null;
  loading: boolean;
  basketPositions: Position[];
  leveragedPositions: any[];
  recentTransactions: any[];
  error: string | null;
}

type Action =
  | { type: 'connect'; address: string }
  | { type: 'disconnect' }
  | { type: 'load_start' }
  | { type: 'load_done'; payload: Omit<State, 'walletAddress' | 'loading' | 'error'> }
  | { type: 'load_error'; error: string };

const initial: State = {
  walletAddress: null,
  loading: false,
  basketPositions: [],
  leveragedPositions: [],
  recentTransactions: [],
  error: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'connect':
      return { ...s, walletAddress: a.address, error: null };
    case 'disconnect':
      return { ...initial };
    case 'load_start':
      return { ...s, loading: true, error: null };
    case 'load_done':
      return { ...s, loading: false, ...a.payload };
    case 'load_error':
      return { ...s, loading: false, error: a.error };
  }
}

interface Ctx extends State {
  refresh: () => Promise<void>;
}

const ContraCtx = createContext<Ctx | null>(null);

export function ContraStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const { publicKey } = useWallet();
  const address = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (address) dispatch({ type: 'connect', address });
    else dispatch({ type: 'disconnect' });
  }, [address]);

  const refresh = useMemo(
    () => async () => {
      if (!address) return;
      dispatch({ type: 'load_start' });
      try {
        const p = await api.portfolio(address);
        dispatch({
          type: 'load_done',
          payload: {
            basketPositions: p.basket_positions as Position[],
            leveragedPositions: p.leveraged_positions,
            recentTransactions: p.recent_transactions,
          },
        });
      } catch (e) {
        dispatch({ type: 'load_error', error: (e as Error).message });
      }
    },
    [address],
  );

  useEffect(() => {
    if (address) refresh();
  }, [address, refresh]);

  const value: Ctx = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <ContraCtx.Provider value={value}>{children}</ContraCtx.Provider>;
}

export function useContraState(): Ctx {
  const v = useContext(ContraCtx);
  if (!v) throw new Error('useContraState outside ContraStateProvider');
  return v;
}
