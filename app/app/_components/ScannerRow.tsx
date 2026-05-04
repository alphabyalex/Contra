'use client';

interface Props {
  question: string;
  source: string;
  pMarket: number;
  pModel: number;
  edge: number;
  daysToClose?: number | null;
  inBasket?: boolean;
}

function ProbBar({ p, color }: { p: number; color: string }) {
  return (
    <div className="h-1.5 bg-surface rounded overflow-hidden w-24">
      <div className="h-full" style={{ width: `${Math.min(100, Math.max(0, p * 100))}%`, background: color }} />
    </div>
  );
}

export function ScannerRow({ question, source, pMarket, pModel, edge, daysToClose, inBasket }: Props) {
  return (
    <tr className="border-t border-border hover:bg-surface/40">
      <td className="px-3 py-2 text-text max-w-lg truncate font-ui">{question}</td>
      <td className="px-3 py-2 text-muted text-xs lowercase">{source}</td>
      <td className="px-3 py-2 text-right font-num text-text">{(pMarket * 100).toFixed(1)}%</td>
      <td className="px-3 py-2"><ProbBar p={pMarket} color="#3B82F6" /></td>
      <td className="px-3 py-2 text-right font-num text-accent">{(pModel * 100).toFixed(1)}%</td>
      <td className="px-3 py-2"><ProbBar p={pModel} color="#22D3EE" /></td>
      <td className="px-3 py-2 text-right font-num text-positive">+{(edge * 100).toFixed(1)}%</td>
      <td className="px-3 py-2 text-right text-muted text-xs">
        {daysToClose != null ? `${Math.round(daysToClose)}d` : '—'}
      </td>
      <td className="px-3 py-2 text-right text-xs">
        {inBasket ? <span className="text-positive">in</span> : <span className="text-muted">—</span>}
      </td>
    </tr>
  );
}
