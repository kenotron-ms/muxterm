import contoursArt from '../assets/backdrop-subjects/contours.svg?url';
import ridgelineArt from '../assets/backdrop-subjects/ridgeline.svg?url';
import botanicalArt from '../assets/backdrop-subjects/botanical.svg?url';
import arcadeArt from '../assets/backdrop-subjects/arcade.svg?url';
import orbitsArt from '../assets/backdrop-subjects/orbits.svg?url';
import rainfallArt from '../assets/backdrop-subjects/rainfall.svg?url';
import confettiArt from '../assets/backdrop-subjects/confetti.svg?url';
import dunesArt from '../assets/backdrop-subjects/dunes.svg?url';
import fanArt from '../assets/backdrop-subjects/fan.svg?url';
import citylightsArt from '../assets/backdrop-subjects/citylights.svg?url';
import petalsArt from '../assets/backdrop-subjects/petals.svg?url';
import geometryArt from '../assets/backdrop-subjects/geometry.svg?url';
import { syncPwaThemeColor } from './theme.js';
import type { ResolvedConfig } from './config.js';

export type AppThemeId = ResolvedConfig['theme']['app'];
export type AppThemeMode = ResolvedConfig['theme']['mode'];

type Scheme = {
  base: string; raised: string; hover: string; border: string;
  text: string; muted: string; accent: string; onAccent: string;
  chat: string; user: string; assistant: string; assistantText: string;
};
export type AppTheme = { id: AppThemeId; label: string; description: string; light: Scheme; dark: Scheme };


/** Subject artwork is an alpha mask. The selected app palette supplies every visible color. */
export const BACKDROPS = [
  { id:'none', label:'Plain', description:'No artwork', image:'' },
  { id:'contours', label:'Contours', description:'Small flowing lines', image:contoursArt },
  { id:'ridgeline', label:'Ridgeline', description:'Mountain peaks', image:ridgelineArt },
  { id:'botanical', label:'Botanical', description:'Leaf sprigs', image:botanicalArt },
  { id:'arcade', label:'Arcade', description:'Little arches', image:arcadeArt },
  { id:'orbits', label:'Orbits', description:'Miniature planets', image:orbitsArt },
  { id:'rainfall', label:'Rainfall', description:'Rain strokes', image:rainfallArt },
  { id:'confetti', label:'Confetti', description:'Scattered shapes', image:confettiArt },
  { id:'dunes', label:'Dunes', description:'Wind-shaped dunes', image:dunesArt },
  { id:'fan', label:'Fan', description:'Folding fans', image:fanArt },
  { id:'citylights', label:'Citylights', description:'Mini skylines', image:citylightsArt },
  { id:'petals', label:'Petals', description:'Loose blossoms', image:petalsArt },
  { id:'geometry', label:'Geometry', description:'Nested shapes', image:geometryArt },
] as const;
export type BackdropId = typeof BACKDROPS[number]['id'];
export function backdropImage(id: string): string {
  return BACKDROPS.find(item => item.id === id)?.image ?? BACKDROPS[1].image;
}

function finish(id: AppThemeId, label: string, description: string, lightBase: string, lightAccent: string, darkBase: string, darkAccent: string): AppTheme {
  const mix = (a: string, b: string, pct: number) => {
    const weight = pct / 100;
    return '#' + [1, 3, 5].map(start => Math.round(
      parseInt(a.slice(start, start + 2), 16) * weight + parseInt(b.slice(start, start + 2), 16) * (1 - weight),
    ).toString(16).padStart(2, '0')).join('');
  };
  return { id, label, description,
    light: { base:lightBase, raised:'#ffffff', hover:mix(lightAccent, '#ffffff', 9), border:mix(lightAccent, '#ffffff', 25), text:mix(lightAccent, '#18252e', 15), muted:mix(lightAccent, '#52616a', 23), accent:lightAccent, onAccent:'#ffffff', chat:mix(lightAccent, '#ffffff', 8), user:mix(lightAccent, '#ffffff', 20), assistant:'#ffffff', assistantText:mix(lightAccent, '#18252e', 15) },
    dark: { base:darkBase, raised:mix(darkAccent, darkBase, 10), hover:mix(darkAccent, darkBase, 17), border:mix(darkAccent, darkBase, 28), text:'#eef1f4', muted:mix(darkAccent, '#aeb8c1', 22), accent:darkAccent, onAccent:darkBase, chat:mix(darkAccent, darkBase, 4), user:mix(darkAccent, darkBase, 24), assistant:mix(darkAccent, darkBase, 12), assistantText:'#f6f7fa' },
  };
}

export const APP_THEMES: readonly AppTheme[] = [
  { id:'neutral', label:'Neutral', description:'Quiet graphite',
    light:{base:'#f4f6f7',raised:'#ffffff',hover:'#e9eef0',border:'#d6dfe3',text:'#26343b',muted:'#586a73',accent:'#3b6475',onAccent:'#ffffff',chat:'#f0f2f3',user:'#e1e8eb',assistant:'#ffffff',assistantText:'#26343b'},
    dark:{base:'#1b2025',raised:'#262d33',hover:'#303a42',border:'#3c4952',text:'#e5ecf0',muted:'#a6b5bd',accent:'#91bfd1',onAccent:'#17242b',chat:'#1b1f23',user:'#35434b',assistant:'#29343b',assistantText:'#f0f4f6'}},
  { id:'mist', label:'Mist', description:'Blue signal',
    light:{base:'#f0f5f7',raised:'#ffffff',hover:'#e1edf1',border:'#cadce3',text:'#203641',muted:'#526c78',accent:'#336f89',onAccent:'#ffffff',chat:'#e5f2f6',user:'#c9e1eb',assistant:'#ffffff',assistantText:'#203641'},
    dark:{base:'#17252e',raised:'#22343e',hover:'#2a4350',border:'#3a5967',text:'#e6f0f3',muted:'#a2bec9',accent:'#8ec7de',onAccent:'#10252f',chat:'#13242e',user:'#31505f',assistant:'#243b47',assistantText:'#f0f7f9'}},
  { id:'linden', label:'Linden', description:'Green circuit',
    light:{base:'#f1f6ef',raised:'#ffffff',hover:'#e5efe3',border:'#d0dfcf',text:'#273c2e',muted:'#556e5a',accent:'#3d7454',onAccent:'#ffffff',chat:'#eaf3e8',user:'#d3e9d4',assistant:'#ffffff',assistantText:'#273c2e'},
    dark:{base:'#1d2a21',raised:'#293b2d',hover:'#324b38',border:'#45634b',text:'#e7f1e8',muted:'#abc5af',accent:'#9bd3a5',onAccent:'#173020',chat:'#19271d',user:'#3b5941',assistant:'#2a4030',assistantText:'#f1f7f1'}},
  { id:'iris', label:'Iris', description:'Violet orbit',
    light:{base:'#f6f3fa',raised:'#ffffff',hover:'#ece6f4',border:'#ded4e8',text:'#39304d',muted:'#6c607c',accent:'#705a9b',onAccent:'#ffffff',chat:'#f0ebf7',user:'#e1d6ef',assistant:'#ffffff',assistantText:'#39304d'},
    dark:{base:'#262034',raised:'#352c47',hover:'#443859',border:'#59496e',text:'#f0eaf8',muted:'#b9abc9',accent:'#c4a9ec',onAccent:'#281d3d',chat:'#221d31',user:'#514169',assistant:'#3b3150',assistantText:'#f7f2fc'}},
  { id:'coral', label:'Coral', description:'Warm signal',
    light:{base:'#fbf4f1',raised:'#ffffff',hover:'#f5e7e1',border:'#ead4cb',text:'#4b332e',muted:'#7a6059',accent:'#a35548',onAccent:'#ffffff',chat:'#f8ece8',user:'#f2d6cd',assistant:'#ffffff',assistantText:'#4b332e'},
    dark:{base:'#312320',raised:'#422e2b',hover:'#543b35',border:'#6b4b43',text:'#f8ebe6',muted:'#d3ada3',accent:'#efa99a',onAccent:'#3b211c',chat:'#301f1f',user:'#63423c',assistant:'#4b3330',assistantText:'#fff3ef'}},
  { id:'lagoon', label:'Lagoon', description:'Open water',
    light:{base:'#f0f7f5',raised:'#ffffff',hover:'#e2f0ec',border:'#c9e0da',text:'#203d3b',muted:'#4d6d69',accent:'#257b76',onAccent:'#ffffff',chat:'#e6f3f0',user:'#cce8e3',assistant:'#ffffff',assistantText:'#203d3b'},
    dark:{base:'#182c2d',raised:'#223d3e',hover:'#2a4c4c',border:'#3c6663',text:'#e5f3f1',muted:'#9fc7c1',accent:'#83d4c9',onAccent:'#143331',chat:'#132a2b',user:'#315956',assistant:'#274443',assistantText:'#f0faf8'}},
  finish('pearl', 'Pearl', 'Soft porcelain', '#f6f5f2', '#5b676f', '#24282b', '#bfcbd0'),
  finish('cobalt', 'Cobalt', 'Deep blue', '#eef2fb', '#335da9', '#171f35', '#9dbbfc'),
  finish('plum', 'Plum', 'Amethyst dusk', '#f6f1f7', '#794c86', '#2a1e32', '#d6a4e0'),
  finish('sage', 'Sage', 'Muted green', '#f3f5ef', '#587459', '#202c23', '#aed0a7'),
  finish('champagne', 'Champagne', 'Warm metal', '#faf6ed', '#8a6841', '#302a22', '#dfc18b'),
  finish('rose', 'Rose', 'Dusty pink', '#faf3f5', '#9b5d76', '#32232b', '#e7acc3'),
  finish('tangerine', 'Tangerine', 'Copper glow', '#fbf4ed', '#a75d31', '#32251d', '#f0b27f'),
];

export function appThemeScheme(id: AppThemeId, mode: AppThemeMode): Scheme {
  const theme = APP_THEMES.find(item => item.id === id) ?? APP_THEMES[0];
  return mode === 'light' ? theme.light : theme.dark;
}

/** App colors are independent of the xterm ANSI palette. */
export function applyAppAppearance(id: AppThemeId, mode: AppThemeMode, backdrop: string, root: HTMLElement = document.documentElement): void {
  const t = appThemeScheme(id, mode);
  const vars: Record<string,string> = {
    '--chrome-bar':t.raised, '--chrome-body':t.base, '--chrome-border':t.border,
    '--chrome-text-dim':t.muted, '--chrome-text-bright':t.text,
    '--chrome-accent':t.accent, '--chrome-driver-accent':t.accent,
    '--chrome-hover':t.hover, '--chrome-danger':mode === 'light' ? '#b34138' : '#f08f89',
    '--mux-page-bg':t.base, '--mux-page-fg':t.text,
    '--ui-on-accent':t.onAccent, '--ui-on-danger':'#ffffff',
    '--ui-success':mode === 'light' ? '#287a53' : '#8dd4a3',
    '--ui-warning':mode === 'light' ? '#9a681d' : '#e9bd6a',
    '--ui-info':t.accent, '--ui-focus':t.accent,
    '--ui-chat-backdrop-color':t.chat,
    '--ui-chat-backdrop-mask':backdrop === 'none' ? 'none' : `url("${backdropImage(backdrop)}")`,
    '--ui-chat-art-ink':`color-mix(in srgb, ${t.accent} ${mode === 'light' ? 9 : 12}%, transparent)`,
    '--ui-chat-user-surface':t.user,
    '--ui-chat-assistant-surface':t.assistant,
    '--ui-chat-assistant-text':t.assistantText,
    '--ui-chat-composer-surface':t.raised,
  };
  for (const [key,value] of Object.entries(vars)) root.style.setProperty(key,value);
  root.style.colorScheme = mode;
  root.dataset.appTheme = id;
  root.dataset.appMode = mode;
  root.dataset.chatBackdrop = backdrop;
  try {
    localStorage.setItem('mux-app-theme', id);
    localStorage.setItem('mux-app-mode', mode);
  } catch { /* The server config remains authoritative. */ }
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute('content', mode);
  syncPwaThemeColor(root);
}
