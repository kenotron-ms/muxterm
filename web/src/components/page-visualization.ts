import { createElement, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';

type Point = { label: string; value: number; detail?: string };

function readPoints(value: string): Point[] {
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is Point => item && typeof item.label === 'string' && typeof item.value === 'number' && Number.isFinite(item.value)).slice(0, 100);
  } catch { return []; }
}

function Chart({ title, caption, chartType, points }: { title: string; caption: string; chartType: string; points: Point[] }) {
  const [selected, setSelected] = useState(0);
  const values = points.map(point => point.value);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const span = max - min || 1;
  const baseline = 100 - ((0 - min) / span) * 100;
  const position = (value: number) => 100 - ((value - min) / span) * 100;
  const active = points[Math.min(selected, points.length - 1)];
  const line = points.map((point, i) => `${points.length === 1 ? 50 : i * 100 / (points.length - 1)},${position(point.value)}`).join(' ');
  return createElement('section', { className:'page-widget', contentEditable:false, 'aria-label':`${title} visualization` },
    createElement('div', { className:'page-widget-heading' }, createElement('strong', null, title), createElement('span', null, chartType === 'line' ? 'Line chart' : 'Bar chart')),
    caption ? createElement('p', { className:'page-widget-caption' }, caption) : null,
    chartType === 'line'
      ? createElement('svg', { className:'page-widget-line', viewBox:'0 0 100 100', preserveAspectRatio:'none', role:'group', 'aria-label':`${title} line chart` },
          createElement('line', { x1:0, x2:100, y1:baseline, y2:baseline, stroke:'var(--ui-document-border)', strokeWidth:0.6 }),
          createElement('polyline', { points:line, fill:'none', stroke:'var(--ui-document-chart-active)', strokeWidth:1.8, vectorEffect:'non-scaling-stroke' }),
          ...points.map((point,i) => createElement('circle', { key:i, cx:points.length === 1 ? 50 : i * 100 / (points.length - 1), cy:position(point.value), r: i === selected ? 2.3 : 1.5, fill:i === selected ? 'var(--ui-document-chart-active)' : 'var(--ui-document-chart-fill)', role:'button', tabIndex:0, 'aria-label':`${point.label}: ${point.value}`, 'aria-pressed':i === selected, style:{cursor:'pointer'}, onMouseDown:(event)=>{ event.preventDefault(); event.stopPropagation(); }, onClick:(event)=>{ event.stopPropagation(); setSelected(i); }, onKeyDown:(event)=>{ if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setSelected(i); } } })))
      : createElement('div', { className:'page-widget-bars', role:'group', 'aria-label':`${title} bar chart` },
          ...points.map((point,i) => createElement('button', { key:i, type:'button', className:`page-widget-bar ${i === selected ? 'selected' : ''}`, title:`${point.label}: ${point.value}`, 'aria-label':`${point.label}: ${point.value}`, 'aria-pressed':i === selected, onClick:()=>setSelected(i) },
            createElement('span', { style:{ height:`${Math.max(2, Math.abs(point.value) / (Math.max(Math.abs(min),Math.abs(max)) || 1) * 100)}%` } })) )),
    createElement('div', { className:'page-widget-labels' }, ...points.map((point,i) => createElement('button', { key:i, type:'button', className:i === selected ? 'selected' : '', onClick:()=>setSelected(i), 'aria-pressed':i === selected }, point.label))),
    active ? createElement('div', { className:'page-widget-detail', 'aria-live':'polite' }, createElement('strong', null, active.label), createElement('span', null, new Intl.NumberFormat().format(active.value)), active.detail ? createElement('p', null, active.detail) : null) : null);
}

export const visualizationBlock = createReactBlockSpec({
  type:'visualization',
  propSchema:{ title:{default:''}, caption:{default:''}, chartType:{default:'bar', values:['bar','line'] as const}, points:{default:'[]'} },
  content:'none',
}, {
  render:({block}) => createElement(Chart, { title:block.props.title, caption:block.props.caption, chartType:block.props.chartType, points:readPoints(block.props.points) }),
})();

export const visualizationCSS = `
.page-widget{border:1px solid var(--ui-document-border);border-radius:var(--ui-radius-xl);padding:var(--ui-space-6) var(--ui-space-7);margin:var(--ui-space-5) 0;background:var(--ui-document-surface);color:var(--ui-document-text);box-shadow:var(--ui-shadow-control);font:var(--ui-text-md)/1.4 var(--ui-font-sans)}
.page-widget-heading{display:flex;justify-content:space-between;align-items:center;gap:var(--ui-space-5)}.page-widget-heading strong{font-size:var(--ui-text-xl)}.page-widget-heading span{color:var(--ui-document-muted);font-size:var(--ui-text-xs)}
.page-widget-caption{margin:var(--ui-space-2) 0 var(--ui-space-5);color:var(--ui-document-muted)}.page-widget-bars{height:var(--ui-chart-height);display:flex;align-items:end;gap:var(--ui-space-4);border-bottom:1px solid var(--ui-document-border);padding:0 var(--ui-space-2)}
.page-widget-bar{height:100%;flex:1;display:flex;align-items:end;border:0;background:transparent;padding:0;cursor:pointer}.page-widget-bar span{display:block;width:100%;min-height:var(--ui-chart-bar-min-height);background:var(--ui-document-chart-fill);border-radius:var(--ui-radius-sm) var(--ui-radius-sm) 0 0;transition:background var(--ui-motion-fast)}.page-widget-bar:hover span,.page-widget-bar.selected span{background:var(--ui-document-chart-active)}
.page-widget-line{width:100%;height:var(--ui-chart-height);overflow:visible}.page-widget-labels{display:flex;gap:var(--ui-space-4);padding:var(--ui-space-3) var(--ui-space-2) 0}.page-widget-labels button{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:var(--ui-document-muted);cursor:pointer;font:var(--ui-text-xs) var(--ui-font-sans)}.page-widget-labels button.selected{color:var(--ui-document-chart-active);font-weight:700}
.page-widget-line circle:focus-visible{stroke:var(--ui-document-text);stroke-width:var(--ui-space-px)}.page-widget-bar:focus-visible,.page-widget-labels button:focus-visible{outline:var(--ui-space-1) solid var(--ui-document-accent);outline-offset:var(--ui-space-1);border-radius:var(--ui-radius-sm)}
.page-widget-labels button{min-height:var(--ui-control-sm)}@media (pointer:coarse){.page-widget-labels button{min-height:var(--ui-control-lg)}}
.page-widget-detail{display:flex;gap:var(--ui-space-4);align-items:baseline;border-top:1px solid var(--ui-document-border);margin-top:var(--ui-space-5);padding-top:var(--ui-space-5)}.page-widget-detail span{color:var(--ui-document-chart-active);font-size:var(--ui-text-2xl);font-weight:700}.page-widget-detail p{color:var(--ui-document-muted);margin:0 0 0 auto}
`;
