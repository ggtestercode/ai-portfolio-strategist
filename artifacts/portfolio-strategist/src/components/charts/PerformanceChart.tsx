import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line } from "recharts";
import { PerformancePoint } from "@workspace/api-client-react";
import { format } from "date-fns";

interface PerformanceChartProps {
  data: PerformancePoint[];
  height?: number;
}

export default function PerformanceChart({ data, height = 300 }: PerformanceChartProps) {
  if (!data || data.length === 0) return <div className="flex items-center justify-center h-full text-muted-foreground">No data available</div>;

  const minVal = Math.min(...data.map(d => Math.min(d.portfolio, d.benchmark)));
  const maxVal = Math.max(...data.map(d => Math.max(d.portfolio, d.benchmark)));
  const buffer = (maxVal - minVal) * 0.1;

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorPortfolio" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
              <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
          <XAxis 
            dataKey="timestamp" 
            tickFormatter={(val) => format(new Date(val), 'MMM d')}
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            minTickGap={30}
          />
          <YAxis 
            domain={[minVal - buffer, maxVal + buffer]} 
            tickFormatter={(val) => `$${(val / 1000).toFixed(1)}k`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={60}
          />
          <Tooltip 
            contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
            itemStyle={{ color: 'hsl(var(--foreground))' }}
            labelFormatter={(val) => format(new Date(val), 'MMM d, yyyy')}
            formatter={(value: number) => [new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value), 'Value']}
          />
          <Area 
            type="monotone" 
            dataKey="portfolio" 
            stroke="hsl(var(--primary))" 
            strokeWidth={2}
            fillOpacity={1} 
            fill="url(#colorPortfolio)" 
            name="Portfolio"
          />
          <Line 
            type="monotone" 
            dataKey="benchmark" 
            stroke="hsl(var(--muted-foreground))" 
            strokeWidth={1.5}
            strokeDasharray="4 4" 
            dot={false}
            name="Benchmark"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
