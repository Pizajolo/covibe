// Small stroke icon set (SF Symbols-like), 16px grid.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (d: React.ReactNode) => (p: P) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    {d}
  </svg>
);

export const IconHome = base(<path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z" />);
export const IconRuns = base(<><path d="M3 3.5h10M3 8h10M3 12.5h6" /></>);
export const IconTeam = base(<><circle cx="5.5" cy="5.5" r="2" /><circle cx="11" cy="6" r="1.6" /><path d="M1.8 13c.4-2.2 1.9-3.4 3.7-3.4s3.3 1.2 3.7 3.4M9.6 9.7c.4-.2.9-.3 1.4-.3 1.5 0 2.7 1 3 2.9" /></>);
export const IconFolder = base(<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />);
export const IconGear = base(<><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /></>);
export const IconPlus = base(<path d="M8 3v10M3 8h10" />);
export const IconPlay = base(<path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none" />);
export const IconStop = base(<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />);
export const IconChat = base(<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" />);
export const IconBrowser = base(<><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" /><path d="M1.8 5.5h12.4M4 4h.1M5.6 4h.1" /></>);
export const IconBell = base(<><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8z" /><path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" /></>);
export const IconQuestion = base(<><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3M8 11.3v.1" /></>);
export const IconCheck = base(<path d="m3.5 8.5 3 3 6-7" />);
export const IconX = base(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconAlert = base(<><path d="M8 2.2 14.2 13H1.8z" /><path d="M8 6.5v3M8 11.3v.1" /></>);
export const IconInfo = base(<><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.5M8 5.2v.1" /></>);
export const IconLoop = base(<><path d="M12.5 6.5A4.5 4.5 0 0 0 4 5.2M3.5 9.5A4.5 4.5 0 0 0 12 10.8" /><path d="M4 2.5v2.7h2.7M12 13.5v-2.7H9.3" /></>);
export const IconCoin = base(<><circle cx="8" cy="8" r="6" /><path d="M9.8 5.8c-.3-.6-1-1-1.8-1-1.1 0-1.9.6-1.9 1.4 0 1.9 3.8 1 3.8 3 0 .8-.8 1.4-1.9 1.4-.9 0-1.6-.4-1.9-1.1M8 3.8v.9M8 11.3v.9" /></>);
export const IconBolt = base(<path d="M9 1.8 3.5 9h4l-1 5.2L12.5 7h-4z" />);
export const IconGauge = base(<><path d="M2.5 11a5.5 5.5 0 1 1 11 0" /><path d="M8 11 10.5 6.8" /></>);
export const IconBranch = base(<><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5 4" /></>);
export const IconCopy = base(<><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M3 10.5V3.8A1.3 1.3 0 0 1 4.3 2.5H11" /></>);
export const IconTrash = base(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3" />);
export const IconFile = base(<><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>);
export const IconCode = base(<path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" />);
export const IconFlow = base(<><rect x="1.8" y="5.5" width="3.5" height="5" rx="1" /><rect x="10.7" y="2.5" width="3.5" height="4" rx="1" /><rect x="10.7" y="9.5" width="3.5" height="4" rx="1" /><path d="M5.3 8h2.7M8 4.5v7M8 4.5h2.7M8 11.5h2.7" /></>);
export const IconArrowLeft = base(<path d="M9.5 3.5 5 8l4.5 4.5" />);
export const IconArrowRight = base(<path d="M6.5 3.5 11 8l-4.5 4.5" />);
export const IconUp = base(<path d="M8 13V3.5M4 7l4-4 4 4" />);
export const IconSend = base(<path d="M8 13V3.5M4 7l4-4 4 4" />);
export const IconSpinner = (p: P) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden className="spin" {...p}>
    <path d="M8 2a6 6 0 1 1-6 6" strokeLinecap="round" />
  </svg>
);
export const IconSparkle = base(<path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8l4.5-1.3z" />);
export const IconClock = base(<><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>);
export const IconPlan = base(<><rect x="3" y="2.5" width="10" height="11.5" rx="1.5" /><path d="M6 2.5V2h4v.5M5.5 6.5l1 1 1.8-2M9.5 6.8H11M5.5 10.5l1 1 1.8-2M9.5 10.8H11" /></>);
export const IconEye = base(<><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></>);
