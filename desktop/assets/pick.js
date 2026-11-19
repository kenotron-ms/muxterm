(input) => {
  const {mode, token} = input;
  if (!['element', 'area'].includes(mode) || !/^[a-f0-9]{32}$/.test(token)) return JSON.stringify({error:'Invalid selection request'});
  window.__muxtermPickResults ||= Object.create(null);
  window.__muxtermPickCancel?.();

  const frame = document.createElement('div');
  const hint = document.createElement('div');
  for (const node of [frame, hint]) {
    node.setAttribute('aria-hidden', 'true');
    Object.assign(node.style, {position:'fixed', pointerEvents:'none', zIndex:'2147483647', boxSizing:'border-box'});
    document.documentElement.appendChild(node);
  }
  Object.assign(frame.style, {display:'none', border:'2px solid #4c7dff', background:'rgba(76,125,255,.16)', borderRadius:'4px', boxShadow:'0 0 0 1px white'});
  hint.textContent = mode === 'element' ? 'Click an element to add it to Chat · Esc to cancel' : 'Drag an area to add it to Chat · Esc to cancel';
  Object.assign(hint.style, {top:'12px', left:'50%', transform:'translateX(-50%)', padding:'8px 12px', color:'white', background:'#172756',
    borderRadius:'8px', font:'600 12px system-ui', boxShadow:'0 3px 12px #0006', whiteSpace:'nowrap'});

  let start = null;
  let finished = false;
  let cleanupTimer;
  const selectorFor = (element) => {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const parts = [];
    for (let node = element; node?.parentElement && node !== document.documentElement; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter(candidate => candidate.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  const box = (x, y, width, height) => {
    Object.assign(frame.style, {display:'block', left:`${x}px`, top:`${y}px`, width:`${width}px`, height:`${height}px`});
  };
  const stop = () => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(cleanupTimer);
    frame.remove(); hint.remove();
    if (window.__muxtermPickCancel === cancel) delete window.__muxtermPickCancel;
  };
  const finish = (value) => {
    if (finished) return;
    finished = true;
    window.__muxtermPickResults[token] = value;
    frame.remove(); hint.remove();
    // The pointer's following click must not activate the underlying page.
    cleanupTimer = setTimeout(stop, 300);
  };
  const cancel = () => { finish({cancelled:true}); stop(); };
  const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onMove = (event) => {
    if (finished) return;
    if (mode === 'element') {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element && element !== frame && element !== hint) {
        const rect = element.getBoundingClientRect();
        box(rect.left, rect.top, rect.width, rect.height);
      }
    } else if (start) {
      box(Math.min(start.x, event.clientX), Math.min(start.y, event.clientY),
        Math.abs(event.clientX - start.x), Math.abs(event.clientY - start.y));
      swallow(event);
    }
  };
  const onDown = (event) => {
    if (finished || event.button !== 0) return;
    if (mode === 'element') {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element && element !== document.documentElement) {
        const rect = element.getBoundingClientRect();
        finish({kind:'element', url:location.href, title:document.title, selector:selectorFor(element),
          tag:element.tagName.toLowerCase(), role:element.getAttribute('role') || '',
          name:(element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim().slice(0,240),
          text:(element.innerText || element.textContent || '').trim().slice(0,600),
          rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
      }
    } else {
      start = {x:event.clientX, y:event.clientY};
      box(start.x, start.y, 0, 0);
    }
    swallow(event);
  };
  const onUp = (event) => {
    if (finished || mode !== 'area' || !start) return;
    const rect = {x:Math.max(0,Math.min(start.x,event.clientX)), y:Math.max(0,Math.min(start.y,event.clientY)),
      width:Math.abs(event.clientX-start.x), height:Math.abs(event.clientY-start.y)};
    if (rect.width >= 12 && rect.height >= 12) {
      const snippets = [...document.querySelectorAll('h1,h2,h3,h4,p,li,label,button,a,input,textarea,[role="heading"]')]
        .filter(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.right > rect.x && bounds.left < rect.x+rect.width && bounds.bottom > rect.y && bounds.top < rect.y+rect.height;
        })
        .slice(0,20).map(element => (element.innerText || element.getAttribute('aria-label') || element.value || '').trim()).filter(Boolean);
      finish({kind:'area', url:location.href, title:document.title, rect,
        text:[...new Set(snippets)].join(' · ').slice(0,1000)});
    } else { frame.style.display = 'none'; start = null; }
    swallow(event);
  };
  const onClick = (event) => { swallow(event); if (finished) stop(); };
  const onKey = (event) => { if (event.key === 'Escape') { swallow(event); cancel(); } };
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__muxtermPickCancel = cancel;
  return JSON.stringify({started:true});
}
