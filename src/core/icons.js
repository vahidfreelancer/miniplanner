/* ---------- icons: inlined Lucide subset (src/00-icons.js), rendered to inline svg ---------- */
import { ICONS } from 'virtual:icons';
import { esc } from './utils.js';

export const _icCache = {};
export function ic(name, size = 16, cls = '') {
  const k = name + '|' + size + '|' + cls;
  if (_icCache[k]) return _icCache[k];
  const inner = ICONS[name] || '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (_icCache[k] =
    `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}

/* MiniPlanner brand (mark/mini-planner-logo.svg & mark/mini-planner-logo-dark.svg):
   Adapts automatically to Day (light) and Night (dark) themes via CSS custom properties. */
let _logoSeq = 0;

export const LOGO = (h = 28) => {
  const gid = `mpg-${++_logoSeq}`;
  const w = Math.round((h * 420) / 104);
  return `<svg class="logo" height="${h}" width="${w}" viewBox="28 28 420 104" role="img" aria-label="MiniPlanner">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color:var(--mp-grad-0,#2563EB)"/>
        <stop offset="1" style="stop-color:var(--mp-grad-1,#06B6D4)"/>
      </linearGradient>
    </defs>
    <g transform="translate(32,32)">
      <rect x="0" y="0" width="96" height="96" rx="22" fill="url(#${gid})"/>
      <circle cx="24" cy="24" r="6" fill="#FFFFFF" opacity="0.95"/>
      <rect x="40" y="18" width="36" height="12" rx="6" fill="#FFFFFF" opacity="0.9"/>
      <rect x="24" y="42" width="52" height="12" rx="6" fill="#FFFFFF" opacity="0.7"/>
      <rect x="24" y="66" width="52" height="12" rx="6" fill="#FFFFFF" opacity="0.35"/>
      <circle cx="70" cy="72" r="14" fill="#FFFFFF"/>
      <path d="M63.5 72 l4.5 4.5 l8.5 -9" fill="none" style="stroke:var(--mp-check,#0E7490)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="150" y="98" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="46" font-weight="600" letter-spacing="-1" style="fill:var(--mp-word-1,#111827)">mini<tspan font-weight="300" style="fill:var(--mp-word-2,#2563EB)">-planner</tspan></text>
    <text x="152" y="122" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="13" font-weight="400" letter-spacing="3" style="fill:var(--mp-tag,#6B7280)">PLAN · TASK · SHIP</text>
  </svg>`;
};

export const MARK = (px = 22) => {
  const gid = `mpk-${++_logoSeq}`;
  return `<svg width="${px}" height="${px}" viewBox="0 0 96 96" aria-hidden="true">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color:var(--mp-grad-0,#2563EB)"/>
        <stop offset="1" style="stop-color:var(--mp-grad-1,#06B6D4)"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="96" height="96" rx="22" fill="url(#${gid})"/>
    <circle cx="24" cy="24" r="6" fill="#FFFFFF" opacity="0.95"/>
    <rect x="40" y="18" width="36" height="12" rx="6" fill="#FFFFFF" opacity="0.9"/>
    <rect x="24" y="42" width="52" height="12" rx="6" fill="#FFFFFF" opacity="0.7"/>
    <rect x="24" y="66" width="52" height="12" rx="6" fill="#FFFFFF" opacity="0.35"/>
    <circle cx="70" cy="72" r="14" fill="#FFFFFF"/>
    <path d="M63.5 72 l4.5 4.5 l8.5 -9" fill="none" style="stroke:var(--mp-check,#0E7490)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
};

export function wsLogo(w, px = 22) {
  return w && w.brand
    ? `<span class="ws-logo brand" style="width:${px}px;height:${px}px">${MARK(px)}</span>`
    : `<span class="ws-logo" style="--c:${w.c};width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.46))}px">${esc(w.name[0])}</span>`;
}
