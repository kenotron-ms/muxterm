import { autoUpdate, computePosition, flip, offset, shift, size, type Placement, type VirtualElement } from '@floating-ui/dom';

export type PopupReference = Element | VirtualElement;

/** Position an open desktop popup; phone sheets keep their own layout. */
export function floatPopup(reference: PopupReference, popup: HTMLElement, placement: Placement, distance = 6, phoneSheet = true): () => void {
  const phone = window.matchMedia('(max-width:700px)');
  const original = {
    position: popup.style.position, left: popup.style.left, top: popup.style.top,
    right: popup.style.right, bottom: popup.style.bottom, maxHeight: popup.style.maxHeight,
    referenceWidth: popup.style.getPropertyValue('--floating-reference-width'),
  };
  let stop: (() => void) | undefined;
  let generation = 0;

  const reset = () => {
    generation++;
    stop?.();
    stop = undefined;
    popup.style.position = original.position;
    popup.style.left = original.left;
    popup.style.top = original.top;
    popup.style.right = original.right;
    popup.style.bottom = original.bottom;
    popup.style.maxHeight = original.maxHeight;
    if (original.referenceWidth) popup.style.setProperty('--floating-reference-width', original.referenceWidth);
    else popup.style.removeProperty('--floating-reference-width');
  };
  const sync = () => {
    reset();
    if (phone.matches && phoneSheet) return;
    const cssMaxHeight = parseFloat(getComputedStyle(popup).maxHeight);
    const maxHeight = Number.isFinite(cssMaxHeight) ? cssMaxHeight : Infinity;
    const current = generation;
    popup.style.position = 'fixed';
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
    stop = autoUpdate(reference, popup, () => {
      popup.style.setProperty('--floating-reference-width', `${reference.getBoundingClientRect().width}px`);
      void computePosition(reference, popup, {
        strategy: 'fixed', placement,
        middleware: [offset(distance), flip({ padding:8 }), shift({ padding:8 }), size({
          padding:8,
          apply({ availableHeight }) {
            popup.style.maxHeight = `${Math.max(0, Math.min(maxHeight, availableHeight))}px`;
          },
        })],
      }).then(({ x, y }) => {
        if (generation !== current) return;
        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
      });
    });
  };
  phone.addEventListener('change', sync);
  sync();
  return () => {
    phone.removeEventListener('change', sync);
    reset();
  };
}

export function pointReference(event: MouseEvent, contextElement: Element): VirtualElement {
  const { clientX:x, clientY:y } = event;
  return {
    contextElement,
    getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
  };
}
