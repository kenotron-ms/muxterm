import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './question-form.js';

const questions = [{ id:'shape', header:'Button shape', question:'Should the button be square or round?', isOther:true, isSecret:false,
  options:[{label:'Square',description:'Use a square button.'},{label:'Round',description:'Use a round button.'}] }];
const meta = { title:'Components/Question form', tags:['autodocs'], render:() => html`<div style="width:min(100%,760px)"><mux-ui-question-form agentLabel="Codex" .questions=${questions}></mux-ui-question-form></div>` } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Choices:Story = {};
export const Phone:Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Answered:Story = { render:() => html`<mux-ui-question-form agentLabel="Codex" .questions=${questions} answered></mux-ui-question-form>` };
export const Secret:Story = { render:() => html`<mux-ui-question-form agentLabel="Codex" .questions=${[{id:'key',header:'Private key',question:'Enter the key',isOther:false,isSecret:true,options:null}]}></mux-ui-question-form>` };
