'use client';

interface Leg {
  leg_index: number;
  source: string;
  market_id: string;
  question: string;
  outcome_label?: string | null;
  p_market_entry: number;
  p_model: number;
  edge: number;
  weight: number;
  outcome?: 0 | 1 | null;
}

function StatusPill({ outcome }: { outcome: 0 | 1 | null | undefined }) {
  const style: React.CSSProperties = {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '2px 8px',
    borderRadius: 10,
    fontFamily: '"DM Sans", sans-serif',
    fontWeight: 500,
  };
  if (outcome === 0) return <span style={{ ...style, background: '#E6F5EE', color: '#00875A' }}>NO</span>;
  if (outcome === 1) return <span style={{ ...style, background: '#FCE9EB', color: '#CC2936' }}>YES</span>;
  return <span style={{ ...style, background: '#F0F0EE', color: '#9B9B9B' }}>open</span>;
}

export function LegTable({ legs }: { legs: Leg[] }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['#', 'Question', 'Source', 'P market', 'P model', 'Edge', 'Weight', 'Status'].map((h, i) => (
              <th
                key={h}
                style={{
                  textAlign: i === 0 || i === 1 || i === 2 ? 'left' : 'right',
                  fontSize: 10,
                  fontWeight: 500,
                  color: '#9B9B9B',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '10px 16px',
                  borderBottom: '1px solid #E5E5E3',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.leg_index} style={{ borderBottom: '1px solid #E5E5E3' }} className="hover:bg-[#F7F7F5]">
              <td style={{ padding: '10px 16px', color: '#9B9B9B', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace' }}>
                {l.leg_index}
              </td>
              <td style={{ padding: '10px 16px', color: '#0A0A0A', fontSize: 13, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.question}
              </td>
              <td style={{ padding: '10px 16px', color: '#6B6B6B', fontSize: 11, textTransform: 'lowercase' }}>
                {l.source}
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: '#CC2936', fontSize: 13 }}>
                {(Number(l.p_market_entry) * 100).toFixed(1)}%
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: '#1A56DB', fontSize: 13 }}>
                {(Number(l.p_model) * 100).toFixed(1)}%
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: '#00875A', fontSize: 13 }}>
                +{(Number(l.edge) * 100).toFixed(1)}%
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', color: '#0A0A0A', fontSize: 13 }}>
                {(Number(l.weight) * 100).toFixed(2)}%
              </td>
              <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                <StatusPill outcome={l.outcome ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
