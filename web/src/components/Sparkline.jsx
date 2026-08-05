// Minimal inline-SVG sparkline. Scales to the series max (with a floor) so a
// flat-but-low series doesn't look like it's pegged.
export default function Sparkline({ data, max, color = '#4f8cff' }) {
  const points = data.filter((n) => Number.isFinite(n));
  if (points.length < 2) return <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none" />;

  const hi = max ?? Math.max(...points, 1);
  const step = 100 / (points.length - 1);
  const y = (v) => 40 - Math.min(1, v / hi) * 36 - 2;

  const line = points.map((v, i) => `${i * step},${y(v)}`).join(' ');
  const area = `0,40 ${line} 100,40`;
  const id = `spark-${color.replace('#', '')}`;

  return (
    <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
