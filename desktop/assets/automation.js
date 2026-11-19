(command) => {
  const visible = (element) => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible' &&
    !element.closest('[hidden],[aria-hidden="true"]');
  const selectorFor = (element) => {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter(candidate => candidate.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  const nameFor = (item) => {
    const labelledBy = item.getAttribute('aria-labelledby');
    const labelled = labelledBy?.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
    return (item.getAttribute('aria-label') || labelled || item.labels?.[0]?.innerText ||
      item.getAttribute('alt') || item.getAttribute('title') || item.getAttribute('placeholder') ||
      item.innerText || '').trim().slice(0, 240);
  };
  const element = () => {
    const target = command.selector ? document.querySelector(command.selector) :
      document.elementFromPoint(command.x ?? 0, command.y ?? 0);
    if (!target) throw new Error('Element not found');
    target.scrollIntoView({block:'center', inline:'center'});
    if (!visible(target)) throw new Error('Element is not visible');
    return target;
  };
  try {
    let result;
    switch (command.action) {
      case 'cursor': {
        const target = element();
        const rect = target.getBoundingClientRect();
        const x = Math.max(8, Math.min(innerWidth - 8, rect.left + rect.width / 2));
        const y = Math.max(8, Math.min(innerHeight - 8, rect.top + rect.height / 2));
        let cursor = window.__muxtermAgentCursor;
        if (!cursor?.isConnected) {
          cursor = document.createElement('div');
          cursor.setAttribute('aria-hidden', 'true');
          Object.assign(cursor.style, {
            position:'fixed', left:'0', top:'0', width:'18px', height:'18px',
            border:'3px solid white', borderRadius:'50%', boxSizing:'border-box',
            background:'#4c7dff', boxShadow:'0 2px 12px #17275699, 0 0 0 2px #4c7dff',
            pointerEvents:'none', zIndex:'2147483647', opacity:'1',
          });
          document.documentElement.appendChild(cursor);
          window.__muxtermAgentCursor = cursor;
        }
        const from = window.__muxtermAgentCursorPoint || {x: Math.max(20, innerWidth * .15), y: Math.max(20, innerHeight * .2)};
        cursor.getAnimations().forEach(animation => animation.cancel());
        cursor.animate([
          {transform:`translate(${from.x - 9}px, ${from.y - 9}px) scale(1)`},
          {transform:`translate(${x - 9}px, ${y - 9}px) scale(1)`},
        ], {duration:360, easing:'cubic-bezier(.42, 0, .58, 1)'});
        cursor.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
        window.__muxtermAgentCursorPoint = {x,y};
        clearTimeout(window.__muxtermAgentCursorFade);
        window.__muxtermAgentCursorFade = setTimeout(() => {
          cursor.animate([{opacity:1, transform:`translate(${x - 9}px, ${y - 9}px) scale(.7)`},
            {opacity:0, transform:`translate(${x - 9}px, ${y - 9}px) scale(1.8)`}],
          {duration:650, easing:'ease-out', fill:'forwards'});
        }, 370);
        result = {cursor:true};
        break;
      }
      case 'inspect':
        result = {
          title: document.title,
          url: location.href,
          text: (document.body?.innerText || '').slice(0, 2000),
          elements: [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
            .filter(visible).slice(0, 40).map(item => {
              const rect = item.getBoundingClientRect();
              return {selector: selectorFor(item), tag: item.tagName.toLowerCase(), role: item.getAttribute('role'), type: item.getAttribute('type'),
                label: nameFor(item),
                x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
            }),
        };
        break;
      case 'click': {
        const target = element();
        target.focus();
        target.click();
        result = {clicked:true};
        break;
      }
      case 'type': {
        const target = command.selector ? element() : document.activeElement;
        if (!target || typeof command.text !== 'string') throw new Error('Choose an element and provide text');
        target.focus();
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const next = target.value.slice(0, start) + command.text + target.value.slice(end);
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
          if (!setter) throw new Error('Input is not editable');
          setter.call(target, next);
          target.setSelectionRange(start + command.text.length, start + command.text.length);
          target.dispatchEvent(new Event('input', {bubbles:true}));
          target.dispatchEvent(new Event('change', {bubbles:true}));
        } else if (target.isContentEditable) {
          document.execCommand('insertText', false, command.text);
        } else {
          throw new Error('Element is not editable');
        }
        result = {typed:true};
        break;
      }
      case 'key': {
        const allowed = ['Enter','Tab','Escape','Backspace','ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End','Delete'];
        if (!allowed.includes(command.key)) throw new Error('Unsupported key');
        const target = document.activeElement;
        if (!target) throw new Error('No focused element');
        target.dispatchEvent(new KeyboardEvent('keydown', {key:command.key,bubbles:true,cancelable:true}));
        if (command.key === 'Enter' && target instanceof HTMLElement) {
          const form = target.closest('form');
          if (form && target.tagName !== 'TEXTAREA') form.requestSubmit();
        }
        target.dispatchEvent(new KeyboardEvent('keyup', {key:command.key,bubbles:true}));
        result = {pressed:command.key};
        break;
      }
      case 'scroll':
        window.scrollBy({left:command.deltaX || 0, top:command.deltaY || 0, behavior:'instant'});
        result = {scrolled:true};
        break;
      default:
        throw new Error('Unsupported browser action');
    }
    return JSON.stringify({result});
  } catch (error) {
    return JSON.stringify({error:String(error?.message || error)});
  }
}
