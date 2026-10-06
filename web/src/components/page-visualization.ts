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
      ? createElement('svg', { className:'page-widget-line', viewBox:'0 0 100 100', preserveAspectRatio:'none', role:'img', 'aria-label':`${title} line chart` },
          createElement('line', { x1:0, x2:100, y1:baseline, y2:baseline, stroke:'#d5dde4', strokeWidth:0.6 }),
          createElement('polyline', { points:line, fill:'none', stroke:'#487db9', strokeWidth:1.8, vectorEffect:'non-scaling-stroke' }),
          ...points.map((point,i) => createElement('circle', { key:i, cx:points.length === 1 ? 50 : i * 100 / (points.length - 1), cy:position(point.value), r: i === selected ? 2.3 : 1.5, fill:i === selected ? '#215a99' : '#64a2d7' })))
      : createElement('div', { className:'page-widget-bars', role:'img', 'aria-label':`${title} bar chart` },
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
.page-widget{border:1px solid #dce2e8;border-radius:14px;padding:18px 20px;margin:12px 0;background:#fbfcfd;color:#24303a;box-shadow:0 2px 8px #1e293b0a;font:13px/1.4 system-ui,sans-serif}
.page-widget-heading{display:flex;justify-content:space-between;align-items:center;gap:10px}.page-widget-heading strong{font-size:15px}.page-widget-heading span{color:#7a8791;font-size:11px}
.page-widget-caption{margin:5px 0 12px;color:#687783}.page-widget-bars{height:150px;display:flex;align-items:end;gap:8px;border-bottom:1px solid #d5dde4;padding:0 4px}
.page-widget-bar{height:100%;flex:1;display:flex;align-items:end;border:0;background:transparent;padding:0;cursor:pointer}.page-widget-bar span{display:block;width:100%;min-height:3px;background:#8bb6dc;border-radius:5px 5px 0 0;transition:background .15s}.page-widget-bar:hover span,.page-widget-bar.selected span{background:#3879b7}
.page-widget-line{width:100%;height:150px;overflow:visible}.page-widget-labels{display:flex;gap:8px;padding:6px 4px 0}.page-widget-labels button{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:#71808c;cursor:pointer;font:11px system-ui,sans-serif}.page-widget-labels button.selected{color:#255d93;font-weight:700}
.page-widget-detail{display:flex;gap:8px;align-items:baseline;border-top:1px solid #e7ebef;margin-top:12px;padding-top:10px}.page-widget-detail span{color:#245e98;font-size:18px;font-weight:700}.page-widget-detail p{color:#687783;margin:0 0 0 auto}
`;
