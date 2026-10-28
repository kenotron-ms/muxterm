import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './mux-notes-meetings-concept.js';

type Screen = 'notes-library' | 'note-editor' | 'meeting-library' | 'meeting-live' | 'meeting-review' | 'call-preflight' | 'call-waiting' | 'video-call' | 'video-call-recording' | 'screen-sharing-call' | 'recording-screen-sharing-call';
interface ConceptArgs { screen: Screen }

const meta = {
  title:'Concepts/Notes and Meetings',
  tags:['autodocs'],
  parameters:{ layout:'fullscreen', fullBleed:true },
  args:{ screen:'notes-library' },
  render:(args:ConceptArgs) => html`<div style="width:100%;height:100vh"><mux-notes-meetings-concept .screen=${args.screen}></mux-notes-meetings-concept></div>`,
} satisfies Meta<ConceptArgs>;

export default meta;
type Story = StoryObj<ConceptArgs>;

/** The default Notes destination: a library, with no item created. */
export const NotesLibrary: Story = {};
export const NoteEditor: Story = { args:{screen:'note-editor'} };
export const MeetingLibrary: Story = { args:{screen:'meeting-library'} };
export const Recording: Story = { args:{screen:'meeting-live'} };
export const CallPreflight: Story = { args:{screen:'call-preflight'} };
export const WaitingForGuest: Story = { args:{screen:'call-waiting'} };
export const VideoCall: Story = { args:{screen:'video-call'} };
export const ScreenSharingCall: Story = { args:{screen:'screen-sharing-call'} };
export const RecordingScreenShare: Story = { args:{screen:'recording-screen-sharing-call'} };
export const RecordingVideoCall: Story = { args:{screen:'video-call-recording'} };
export const MeetingReview: Story = { args:{screen:'meeting-review'} };
export const PhoneNotes: Story = { args:{screen:'notes-library'}, globals:{viewport:{value:'phone390',isRotated:false}} };
export const PhoneMeeting: Story = { args:{screen:'meeting-library'}, globals:{viewport:{value:'phone390',isRotated:false}} };
export const PhoneVideoCall: Story = { args:{screen:'video-call-recording'}, globals:{viewport:{value:'phone390',isRotated:false}} };
export const PhoneScreenSharing: Story = { args:{screen:'screen-sharing-call'}, globals:{viewport:{value:'phone390',isRotated:false}} };
