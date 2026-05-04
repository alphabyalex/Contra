'use client';

/**
 * NAV line chart for a basket. Accepts a `data` array of { t, nav }
 * pairs; if empty renders a placeholder so the page doesn't jump on
 * first paint.
 */

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { COLORS } from '../_lib/tokens';

export interface NavPoint { t: string; nav: number }

export function NavChart({ data, height = 240 }: { data: NavPoint[]; height?: number }) {
  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-muted text-xs uppercase tracking-widest border border-border rounded"
        style={{ height }}
      >
        no nav history yet
      </div>
    );
  }
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
          <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            stroke={COLORS.muted}
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
          />
          <YAxis stroke={COLORS.muted} fontSize={10} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              fontSize: 12,
              color: COLORS.text,
            }}
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number) => [v.toFixed(4), 'NAV']}
          />
          <Line type="monotone" dataKey="nav" stroke={COLORS.accent} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
