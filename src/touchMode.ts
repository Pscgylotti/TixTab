import { getTouchMode, subscribeTouchMode } from './inputPreferences';

// Adapt before React receives the native event, so every canvas tool follows
// the same mouse path without changing pen pressure or ordinary UI controls.
const replayed = new WeakSet<Event>();
export const isTouchReplay = (event: Event) => replayed.has(event);
type Contact = { target: Element; host: Element; event: PointerEvent; navigation: boolean };
export function installTouchMode() {
  const contacts = new Map<number, Contact>();
  const dispatch = (
    contact: Contact,
    type: string,
    pointerType: string,
    target = contact.target,
  ) => {
    const original = contact.event;
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: original.pointerId,
      pointerType,
      clientX: original.clientX,
      clientY: original.clientY,
      button: 0,
      buttons: type === 'pointercancel' ? 0 : 1,
      pressure: type === 'pointercancel' ? 0 : 0.5,
      isPrimary: original.isPrimary,
    });
    replayed.add(event);
    target.dispatchEvent(event);
  };
  const cancel = () => {
    for (const contact of contacts.values())
      dispatch(contact, 'pointercancel', contact.navigation ? 'touch' : 'mouse');
    contacts.clear();
  };
  const handle = (event: PointerEvent) => {
    if (replayed.has(event) || event.pointerType !== 'touch') return;
    let contact = contacts.get(event.pointerId);
    if (event.type === 'pointerdown') {
      if (!getTouchMode() || !(event.target instanceof Element)) return;
      const target = event.target;
      if (
        target.closest('a,input,textarea,select,[contenteditable="true"],.presentation-view') ||
        (target.closest('button') &&
          !target.closest('.object-handle,.review-region,.review-resize-handle'))
      )
        return;
      const host = target.closest(
        '.surface,.reading-view,.scratch-viewport,.formula-canvas,.sketch-editor',
      );
      if (!host) return;
      const others = [...contacts.values()].filter((c) => c.host === host);
      contact = { target, host, event, navigation: others.length > 0 };
      contacts.set(event.pointerId, contact);
      for (const other of others) {
        if (other.navigation) continue;
        // Roll back the tentative stroke/transform before starting a pinch.
        dispatch(other, 'pointercancel', 'mouse');
        other.navigation = true;
        const replayTarget = host.matches('.sketch-editor') ? other.target : host;
        dispatch(other, 'pointerdown', 'touch', replayTarget);
      }
    }
    if (!contact) return;
    contact.event = event;
    if (!contact.navigation)
      Object.defineProperty(event, 'pointerType', { value: 'mouse', configurable: true });
    if (event.type === 'pointerup' || event.type === 'pointercancel')
      contacts.delete(event.pointerId);
  };
  const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;
  types.forEach((type) => window.addEventListener(type, handle, true));
  const hidden = () => {
    if (document.hidden) cancel();
  };
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', hidden);
  const unsubscribe = subscribeTouchMode(cancel);
  return () => {
    cancel();
    unsubscribe();
    types.forEach((type) => window.removeEventListener(type, handle, true));
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', hidden);
  };
}
