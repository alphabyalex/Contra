'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../_lib/api';
import { NavChart, type NavPoint } from '../../_components/NavChart';
import { LegTable } from '../../_components/LegTable';
import { DepositForm } from '../../_components/DepositForm';

export default function BasketDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const [data, setData] = useState<any>(null);
  const [history, setHistory] = useState<NavPoint[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.baskets.get(id).then(setData).catch((e) => setErr(e.message));
    api.baskets
      .nav(id)
      .then((r) => setHistory(r.history.map((h) => ({ t: h.snapshotted_at, nav: Number(h.nav) }))))
      .catch(() => setHistory([]));
  }, [id]);

  if (err) {
    return (
      <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }} className="p-8">
        <div style={{ color: '#CC2936', fontSize: 13 }}>{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }} className="p-8">
        <div style={{ color: '#9B9B9B', fontSize: 13 }}>Loading basket...</div>
      </div>
    );
  }

  const { basket, legs, nav } = data;
  const isUp = nav >= 1;

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 300, color: '#0A0A0A', margin: 0 }}>{basket.name}</h1>
            <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8 }}>
              {basket.leverage_type} · {basket.category ?? 'mixed'} · {basket.num_legs} legs · status {basket.status}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>NAV</div>
            <div className="font-num" style={{ fontSize: 32, color: isUp ? '#00875A' : '#CC2936' }}>
              ${nav.toFixed(4)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
              <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                NAV history
              </div>
              <NavChart data={history} />
            </div>
            <LegTable legs={legs} />
          </div>
          <div className="space-y-4">
            <DepositForm basketId={basket.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
