import neutralLight from '../assets/chat-themes/neutral-light.webp?url';
import neutralDark from '../assets/chat-themes/neutral-dark.webp?url';
import mistLight from '../assets/chat-themes/mist-light.webp?url';
import mistDark from '../assets/chat-themes/mist-dark.webp?url';
import lindenLight from '../assets/chat-themes/linden-light.webp?url';
import lindenDark from '../assets/chat-themes/linden-dark.webp?url';
import irisLight from '../assets/chat-themes/iris-light.webp?url';
import irisDark from '../assets/chat-themes/iris-dark.webp?url';
import coralLight from '../assets/chat-themes/coral-light.webp?url';
import coralDark from '../assets/chat-themes/coral-dark.webp?url';
import lagoonLight from '../assets/chat-themes/lagoon-light.webp?url';
import lagoonDark from '../assets/chat-themes/lagoon-dark.webp?url';
import { syncPwaThemeColor } from './theme.js';
import type { ResolvedConfig } from './config.js';

export type AppThemeId = ResolvedConfig['theme']['app'];
export type AppThemeMode = ResolvedConfig['theme']['mode'];
export type ChatBackdropId = ResolvedConfig['theme']['backdrop'];

type Scheme = {
  base: string; raised: string; hover: string; border: string;
  text: string; muted: string; accent: string; onAccent: string;
  chat: string; user: string; assistant: string; assistantText: string;
};
export type AppTheme = { id: AppThemeId; label: string; description: string; light: Scheme; dark: Scheme };

export const APP_THEMES: readonly AppTheme[] = [
  { id:'neutral', label:'Neutral', description:'Quiet graphite',
    light:{base:'#f4f6f7',raised:'#ffffff',hover:'#e9eef0',border:'#d6dfe3',text:'#26343b',muted:'#64757e',accent:'#3b6475',onAccent:'#ffffff',chat:'#f0f2f3',user:'#e1e8eb',assistant:'#ffffff',assistantText:'#26343b'},
    dark:{base:'#1b2025',raised:'#262d33',hover:'#303a42',border:'#3c4952',text:'#e5ecf0',muted:'#a6b5bd',accent:'#91bfd1',onAccent:'#17242b',chat:'#1b1f23',user:'#35434b',assistant:'#29343b',assistantText:'#f0f4f6'}},
  { id:'mist', label:'Mist', description:'Blue signal',
    light:{base:'#f0f5f7',raised:'#ffffff',hover:'#e1edf1',border:'#cadce3',text:'#203641',muted:'#607782',accent:'#336f89',onAccent:'#ffffff',chat:'#e5f2f6',user:'#c9e1eb',assistant:'#ffffff',assistantText:'#203641'},
    dark:{base:'#17252e',raised:'#22343e',hover:'#2a4350',border:'#3a5967',text:'#e6f0f3',muted:'#a2bec9',accent:'#8ec7de',onAccent:'#10252f',chat:'#13242e',user:'#31505f',assistant:'#243b47',assistantText:'#f0f7f9'}},
  { id:'linden', label:'Linden', description:'Green circuit',
    light:{base:'#f1f6ef',raised:'#ffffff',hover:'#e5efe3',border:'#d0dfcf',text:'#273c2e',muted:'#657b69',accent:'#3d7454',onAccent:'#ffffff',chat:'#eaf3e8',user:'#d3e9d4',assistant:'#ffffff',assistantText:'#273c2e'},
    dark:{base:'#1d2a21',raised:'#293b2d',hover:'#324b38',border:'#45634b',text:'#e7f1e8',muted:'#abc5af',accent:'#9bd3a5',onAccent:'#173020',chat:'#19271d',user:'#3b5941',assistant:'#2a4030',assistantText:'#f1f7f1'}},
  { id:'iris', label:'Iris', description:'Violet orbit',
    light:{base:'#f6f3fa',raised:'#ffffff',hover:'#ece6f4',border:'#ded4e8',text:'#39304d',muted:'#796e8a',accent:'#705a9b',onAccent:'#ffffff',chat:'#f0ebf7',user:'#e1d6ef',assistant:'#ffffff',assistantText:'#39304d'},
    dark:{base:'#262034',raised:'#352c47',hover:'#443859',border:'#59496e',text:'#f0eaf8',muted:'#b9abc9',accent:'#c4a9ec',onAccent:'#281d3d',chat:'#221d31',user:'#514169',assistant:'#3b3150',assistantText:'#f7f2fc'}},
  { id:'coral', label:'Coral', description:'Warm signal',
    light:{base:'#fbf4f1',raised:'#ffffff',hover:'#f5e7e1',border:'#ead4cb',text:'#4b332e',muted:'#8b7068',accent:'#a35548',onAccent:'#ffffff',chat:'#f8ece8',user:'#f2d6cd',assistant:'#ffffff',assistantText:'#4b332e'},
    dark:{base:'#312320',raised:'#422e2b',hover:'#543b35',border:'#6b4b43',text:'#f8ebe6',muted:'#d3ada3',accent:'#efa99a',onAccent:'#3b211c',chat:'#301f1f',user:'#63423c',assistant:'#4b3330',assistantText:'#fff3ef'}},
  { id:'lagoon', label:'Lagoon', description:'Open water',
    light:{base:'#f0f7f5',raised:'#ffffff',hover:'#e2f0ec',border:'#c9e0da',text:'#203d3b',muted:'#607e7a',accent:'#257b76',onAccent:'#ffffff',chat:'#e6f3f0',user:'#cce8e3',assistant:'#ffffff',assistantText:'#203d3b'},
    dark:{base:'#182c2d',raised:'#223d3e',hover:'#2a4c4c',border:'#3c6663',text:'#e5f3f1',muted:'#9fc7c1',accent:'#83d4c9',onAccent:'#143331',chat:'#132a2b',user:'#315956',assistant:'#274443',assistantText:'#f0faf8'}},
];

export const CHAT_BACKDROPS: readonly { id: ChatBackdropId; label: string; light: string; dark: string }[] = [
  { id:'neutral', label:'Sparse', light:neutralLight, dark:neutralDark },
  { id:'mist', label:'Waves', light:mistLight, dark:mistDark },
  { id:'linden', label:'Connections', light:lindenLight, dark:lindenDark },
  { id:'iris', label:'Orbits', light:irisLight, dark:irisDark },
  { id:'coral', label:'Doodles', light:coralLight, dark:coralDark },
  { id:'lagoon', label:'Current', light:lagoonLight, dark:lagoonDark },
];

export function chatBackdropImage(id: ChatBackdropId, mode: AppThemeMode): string {
  const backdrop = CHAT_BACKDROPS.find(item => item.id === id) ?? CHAT_BACKDROPS[0];
  return mode === 'light' ? backdrop.light : backdrop.dark;
}

export function appThemeScheme(id: AppThemeId, mode: AppThemeMode): Scheme {
  const theme = APP_THEMES.find(item => item.id === id) ?? APP_THEMES[0];
  return mode === 'light' ? theme.light : theme.dark;
}

/** App colors are independent of the xterm ANSI palette. */
export function applyAppAppearance(id: AppThemeId, mode: AppThemeMode, backdrop: ChatBackdropId, root: HTMLElement = document.documentElement): void {
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
    '--ui-chat-backdrop-image':`url("${chatBackdropImage(backdrop, mode)}")`,
    '--ui-chat-backdrop-wash':mode === 'light' ? 'rgba(255,255,255,.44)' : 'rgba(0,0,0,.18)',
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
