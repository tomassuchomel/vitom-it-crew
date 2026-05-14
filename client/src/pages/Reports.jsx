import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { Input, Select } from './ProjectsList.jsx';
import { reports as reportsApi } from '../api.js';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';

const PIE_COLORS = ['#3b6cf6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

const DEFAULTS = () => {
  const today = new Date();
  const monthAgo = new Date(); monthAgo.setDate(today.getDate() - 30);
  return { from: monthAgo.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
};

export default function Reports() {
  const [{ from, to }, setRange] = useState(DEFAULTS);
  const [groupBy, setGroupBy] = useState('project'); // project | user | day | week | month
  const [data, setData] = useState({ rows: [], total_hours: 0, total_cost: 0 });
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      reportsApi.summary({ from, to, groupBy }),
      reportsApi.costs(),
    ]).then(([s, c]) => { setData(s); setCosts(c.rows); })
      .finally(() => setLoading(false));
  }, [from, to, groupBy]);

  const setPreset = (days) => {
    const t = new Date();
    const f = new Date(); f.setDate(t.getDate() - days);
    setRange({ from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) });
  };

  const chartData = data.rows.map((r, i) => ({
    name: r.label, hours: Number(r.hours.toFixed(1)), cost: Math.round(r.cost),
  }));

  return (
    <div>
      <PageHeader title="Reporty" subtitle="Hodiny, náklady a výkon týmu" />
      <div className="p-6 space-y-6">

        {/* Filtry */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-3">
          <Input label="Od" type="date" value={from} onChange={(v) => setRange((r) => ({ ...r, from: v }))} />
          <Input label="Do" type="date" value={to} onChange={(v) => setRange((r) => ({ ...r, to: v }))} />
          <Select label="Seskupit podle" value={groupBy} onChange={setGroupBy} options={[
            { value: 'project', label: 'Projekt' },
            { value: 'user',    label: 'Osoba' },
            { value: 'day',     label: 'Den' },
            { value: 'week',    label: 'Týden' },
            { value: 'month',   label: 'Měsíc' },
          ]} />
          <div className="flex gap-1">
            {[7, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setPreset(d)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >Posl. {d} dní</button>
            ))}
          </div>
        </div>

        {/* Souhrnné karty */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SummaryCard label="Hodin celkem" value={`${Number(data.total_hours).toFixed(1)} h`} />
          <SummaryCard label="Náklady celkem" value={`${Math.round(data.total_cost).toLocaleString('cs-CZ')} Kč`} />
          <SummaryCard label="Skupin" value={data.rows.length} />
        </div>

        {/* Bar / Line graf */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4">Hodiny v období</h3>
          {loading ? (
            <div className="text-slate-400 text-sm">Načítám…</div>
          ) : chartData.length === 0 ? (
            <div className="text-slate-400 text-sm">Žádná data</div>
          ) : ['day', 'week', 'month'].includes(groupBy) ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="hours" stroke="#3b6cf6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="hours" fill="#3b6cf6" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Pie podíl + tabulka */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-800 mb-4">Podíl ({groupBy})</h3>
            {chartData.length === 0 ? (
              <div className="text-slate-400 text-sm">Žádná data</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={chartData} dataKey="hours" nameKey="name" outerRadius={100} label>
                    {chartData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-800 mb-4">Detail tabulka</h3>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500 tracking-wide border-b border-slate-200">
                <tr>
                  <th className="text-left py-2">Skupina</th>
                  <th className="text-right py-2">Hodin</th>
                  <th className="text-right py-2">Náklady</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2">{r.label}</td>
                    <td className="py-2 text-right font-medium">{r.hours.toFixed(1)}</td>
                    <td className="py-2 text-right">{Math.round(r.cost).toLocaleString('cs-CZ')} Kč</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Náklady projektů – vždy celkové */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4">Celkové náklady na projekty</h3>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 tracking-wide border-b border-slate-200">
              <tr>
                <th className="text-left py-2">Projekt</th>
                <th className="text-right py-2">Hodin</th>
                <th className="text-right py-2">Náklady</th>
                <th className="text-right py-2">Rozpočet</th>
                <th className="text-right py-2">Zbývá</th>
              </tr>
            </thead>
            <tbody>
              {costs.map(p => {
                const remain = p.budget ? (p.budget - p.cost) : null;
                const overBudget = remain !== null && remain < 0;
                return (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 font-medium">{p.name}</td>
                    <td className="py-2 text-right">{p.hours.toFixed(1)}</td>
                    <td className="py-2 text-right">{Math.round(p.cost).toLocaleString('cs-CZ')} Kč</td>
                    <td className="py-2 text-right text-slate-600">{p.budget ? `${Number(p.budget).toLocaleString('cs-CZ')} Kč` : '—'}</td>
                    <td className={`py-2 text-right font-semibold ${overBudget ? 'text-red-600' : 'text-emerald-600'}`}>
                      {remain !== null ? `${Math.round(remain).toLocaleString('cs-CZ')} Kč` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="text-xs uppercase text-slate-500 tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-slate-800 mt-1">{value}</div>
    </div>
  );
}
