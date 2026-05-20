'use client';

/**
 * NAV line chart for a basket. Accepts a `data` array of { t, nav } pairs.
 *
 * Axis behaviour:
 *   - Y-axis is fixed to [0, 2.0]; NAV can never go negative and we want
 *     stable framing across baskets.
 *   - X-axis ticks: max 8 evenly-spaced points from the data. Labels are
 *     time-only when all data is the same calendar day; otherwise the
 *     first tick of each day shows "MMM D, h:mm A" and subsequent ticks
 *     that day show just "h:mm A". No label is repeated back-to-back.
 *   - Side padding of 20px on the container so the line never touches
 *     the card edges.
 */

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { COLORS } from '../_lib/tokens';

export interface NavPoint { t: string; nav: number }

const Y_DOMAIN: [number, number] = [0, 2];
const Y_TICKS = [0, 0.5, 1, 1.5, 2];
const MAX_X_TICKS = 8;

export function NavChart({ data, height = 240 }: { data: NavPoint[]; height?: number }) {
  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-muted text-xs uppercase tracking-widest border border-border rounded"
        style={{ height, paddingLeft: 20, paddingRight: 20 }}
      >
        no nav history yet
      </div>
    );
  }

  const { ticks, labels } = useMemoTicks(data);

  return (
    <div style={{ width: '100%', height, paddingLeft: 20, paddingRight: 20 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
          <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            stroke={COLORS.muted}
            fontSize={10}
            tickLine={false}
            axisLine={false}
            ticks={ticks}
            interval={0}
            tickFormatter={(v) => labels[v] ?? ''}
          />
          <YAxis
            stroke={COLORS.muted}
            fontSize={10}
            tickLine={false}
            axisLine={false}
            domain={Y_DOMAIN}
            ticks={Y_TICKS}
            tickFormatter={(v) => v.toFixed(1)}
          />
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

/**
 * Compute up to MAX_X_TICKS evenly-spaced tick values from the data,
 * plus a label map keyed by the data's `t` string. We compute labels in
 * one pass so we can detect "first tick of a new calendar day" — Recharts
 * calls tickFormatter independently per tick with no state.
 */
function useMemoTicks(data: NavPoint[]): { ticks: string[]; labels: Record<string, string> } {
  const n = data.length;
  const step = Math.max(1, Math.ceil(n / MAX_X_TICKS));
  const picked: NavPoint[] = [];
  for (let i = 0; i < n; i += step) picked.push(data[i]);
  // Always include the last point so the chart visibly ends on the
  // most recent NAV.
  if (picked[picked.length - 1]?.t !== data[n - 1].t) picked.push(data[n - 1]);

  const firstDate = new Date(data[0].t);
  const lastDate = new Date(data[n - 1].t);
  const sameDay = isSameDay(firstDate, lastDate);

  const labels: Record<string, string> = {};
  let lastDayKey: string | null = null;
  let lastLabel: string | null = null;
  for (const p of picked) {
    const d = new Date(p.t);
    const dayKey = d.toDateString();
    let label: string;
    if (sameDay) {
      label = formatTime(d);
    } else if (dayKey !== lastDayKey) {
      label = `${formatDateShort(d)}, ${formatTime(d)}`;
    } else {
      label = formatTime(d);
    }
    // De-dupe back-to-back identical labels — when too many points land
    // in the same minute, we'd otherwise repeat "12:00 AM" several times.
    if (label === lastLabel) label = '';
    if (label) lastLabel = label;
    labels[p.t] = label;
    lastDayKey = dayKey;
  }

  return { ticks: picked.map((p) => p.t), labels };
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
