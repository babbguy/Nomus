import { PieChart, Pie, Cell } from 'recharts';

interface ScoreGaugeProps {
  score: number; // 0-100
  size?: number;
  label?: string;
}

export default function ScoreGauge({ score, size = 160, label = 'Compliance Score' }: ScoreGaugeProps) {
  const data = [
    { value: score },
    { value: 100 - score },
  ];

  const color = score >= 80 ? '#00e5a0' : score >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size / 2 + 20 }}>
        <PieChart width={size} height={size}>
          <Pie
            data={data}
            cx={size / 2}
            cy={size / 2}
            startAngle={180}
            endAngle={0}
            innerRadius={size / 2 - 16}
            outerRadius={size / 2 - 4}
            dataKey="value"
            stroke="none"
          >
            <Cell fill={color} />
            <Cell fill="#2a2d3a" />
          </Pie>
        </PieChart>
        <div className="absolute inset-0 flex items-end justify-center pb-2">
          <span className="text-3xl font-bold text-text-primary">{score}</span>
        </div>
      </div>
      <p className="text-xs text-text-muted mt-1">{label}</p>
    </div>
  );
}
