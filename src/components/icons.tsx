/** Line icons at a consistent weight, so a grid of them reads as one set. */
const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icon = {
  shield: () => <svg viewBox="0 0 24 24" {...p}><path d="M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>,
  boxes: () => <svg viewBox="0 0 24 24" {...p}><path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z"/><path d="M3 8.5V16l9 4.5V13"/><path d="M21 8.5V16l-9 4.5"/></svg>,
  route: () => <svg viewBox="0 0 24 24" {...p}><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18h6a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/></svg>,
  clipboard: () => <svg viewBox="0 0 24 24" {...p}><path d="M9 4h6v3H9z"/><path d="M15 5.5h2.5A1.5 1.5 0 0 1 19 7v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9"/><path d="m9 13 2 2 4-4"/></svg>,
  phone: () => <svg viewBox="0 0 24 24" {...p}><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>,
  lock: () => <svg viewBox="0 0 24 24" {...p}><rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>,
  fuel: () => <svg viewBox="0 0 24 24" {...p}><path d="M4 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15"/><path d="M3 20h11"/><path d="M13 9h3a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-2.5-2.5"/><path d="M6 8h5"/></svg>,
  chart: () => <svg viewBox="0 0 24 24" {...p}><path d="M4 20V4"/><path d="M4 20h16"/><path d="m7 15 3.5-4 3 2.5L19 7"/></svg>,
  factory: () => <svg viewBox="0 0 24 24" {...p}><path d="M3 20V10l5 3V10l5 3V7l6 3v10Z"/><path d="M8 20v-3M13 20v-3M18 20v-3"/></svg>,
  truck: () => <svg viewBox="0 0 24 24" {...p}><path d="M2 7h11v9H2z"/><path d="M13 10h4l4 3.5V16h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>,
  building: () => <svg viewBox="0 0 24 24" {...p}><path d="M4 21V5l8-2 8 2v16"/><path d="M2 21h20"/><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01"/></svg>,
  drill: () => <svg viewBox="0 0 24 24" {...p}><path d="M12 3v7"/><path d="m7 10 5 11 5-11Z"/><path d="M6 10h12"/></svg>,
};
