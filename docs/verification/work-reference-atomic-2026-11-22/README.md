# Work reference layout

The `before-640.png` browser capture shows Work #45 breaking between “Work” and “#45”. The `after-640.png` capture shows the same long title with an intact reference. The remaining captures show desktop, 390px, 320px, a 285px Work pane beside a chat, an assistant link, and a chat digest/notice layout. The digest/notice capture uses browser fixture state backed by a real dev-local Work item.

In a fresh isolated dev-local instance, Chromium measured one text line for each visible Work #45–#47 reference and zero horizontal overflow at the captured sizes. Work row touch and keyboard activation, assistant-link keyboard activation, and dependency-link activation opened the exact Work details. The assistant link retained a visible 2px focus outline. No production service was used.
