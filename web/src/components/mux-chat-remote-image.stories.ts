import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { MuxChatRemoteImage } from './mux-chat-remote-image.js';
import './mux-chat-remote-image.js';

interface ImageArgs { source:string; alt:string }
const sourceURL = (source:string) => source === 'rejected' ? 'javascript:alert(1)' : new URL(source,window.location.href).href;
const meta = {
  title:'Patterns/Remote image', tags:['autodocs'],
  args:{source:'/component-preview.svg',alt:'Component library preview'},
  parameters:{layout:'fullscreen',fullBleed:true},
  render:(args:ImageArgs) => html`<article style="max-width:560px;padding:var(--ui-space-7);color:var(--ui-text);font:var(--ui-text-md)/1.5 var(--ui-font-sans)"><p>A chat message with a reader-approved image:</p><mux-chat-remote-image .src=${sourceURL(args.source)} .alt=${args.alt}></mux-chat-remote-image></article>`,
} satisfies Meta<ImageArgs>;
export default meta;
type Story = StoryObj<ImageArgs>;

async function request(canvasElement:HTMLElement):Promise<MuxChatRemoteImage> {
  const image = canvasElement.querySelector<MuxChatRemoteImage>('mux-chat-remote-image');
  if (!image) throw new Error('Remote image is missing');
  await image.updateComplete;
  image.shadowRoot?.querySelector<HTMLElement>('mux-ui-button')?.click();
  await image.updateComplete;
  return image;
}

export const Consent:Story = {};
export const Loaded:Story = {
  play:async ({canvasElement}) => {
    const image = await request(canvasElement);
    await image.shadowRoot?.querySelector<HTMLImageElement>('img')?.decode();
  },
};
export const FailedLoad:Story = {
  args:{source:'missing-component-preview.png'},
  play:async ({canvasElement}) => {
    const image = await request(canvasElement);
    await image.shadowRoot?.querySelector<HTMLImageElement>('img')?.decode().catch(() => {});
    await image.updateComplete;
  },
};
export const ChangedSourceNeedsConsent:Story = {
  play:async ({canvasElement}) => {
    const image = await request(canvasElement);
    await image.shadowRoot?.querySelector<HTMLImageElement>('img')?.decode();
    image.src = `${image.src}?review=next`;
    await image.updateComplete;
  },
};
export const RejectedURL:Story = { args:{source:'rejected'} };
export const PhoneConsent:Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const PhoneLoaded:Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:Loaded.play,
};
