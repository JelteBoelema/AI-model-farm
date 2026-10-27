import { formatMoney } from "@/lib/money";

export interface SpendPoint {
  day: string;
  measuredMicros: bigint;
  estimatedMicros: bigint;
}

/** Daily stacked bars: measured (solid) and estimated (hatched tint). Server-rendered SVG. */
export function SpendChart({ data }: { data: SpendPoint[] }) {
  const max = data.reduce((m, d) => (d.measuredMicros + d.estimatedMicros > m ? d.measuredMicros + d.estimatedMicros : m), 0n);
  const width = 600;
  const height = 140;
  const gap = 3;
  const barW = (width - gap * (data.length - 1)) / data.length;
  const scale = (v: bigint) => (max === 0n ? 0 : Number((v * BigInt(height - 4) * 1000n) / max) / 1000);

  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" role="img" aria-label={`Daily spend over the last ${data.length} days`}>
        <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border" />
        {data.map((d, i) => {
          const mh = scale(d.measuredMicros);
          const eh = scale(d.estimatedMicros);
          const x = i * (barW + gap);
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${formatMoney(d.measuredMicros)} measured, ${formatMoney(d.estimatedMicros)} estimated`}</title>
              <rect x={x} y={0} width={barW} height={height} className="fill-transparent" />
              <rect x={x} y={height - mh} width={barW} height={mh} rx={2} className="fill-chart-1" />
              <rect x={x} y={height - mh - eh} width={barW} height={eh} rx={2} className="fill-warning/60" />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-chart-1" aria-hidden /> Measured / provider-reported
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-warning/60" aria-hidden /> Estimated
        </span>
        <span className="ml-auto">Peak day: {formatMoney(max)}</span>
      </figcaption>
    </figure>
  );
}
