import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { AllocationSlice } from "@workspace/api-client-react";

interface AllocationDonutProps {
  allocation: AllocationSlice[];
  size?: number;
}

export default function AllocationDonut({ allocation, size = 200 }: AllocationDonutProps) {
  // Using standard CSS variables for colors, recharts needs hex or var references
  const COLORS = [
    "hsl(var(--chart-1))",
    "hsl(var(--chart-2))",
    "hsl(var(--chart-3))",
    "hsl(var(--chart-4))",
    "hsl(var(--chart-5))",
  ];

  return (
    <div style={{ width: size, height: size }} className="relative mx-auto">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={allocation}
            cx="50%"
            cy="50%"
            innerRadius="60%"
            outerRadius="80%"
            paddingAngle={2}
            dataKey="percentage"
            stroke="none"
          >
            {allocation.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip 
            formatter={(value: number) => [`${value.toFixed(1)}%`, 'Target']}
            contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
            itemStyle={{ color: 'hsl(var(--foreground))' }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-xs text-muted-foreground font-medium">Target</span>
        <span className="text-sm font-bold">Allocation</span>
      </div>
    </div>
  );
}
