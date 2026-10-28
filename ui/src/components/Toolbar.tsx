import { NotificationBell } from './Notifications';

// The window's title bar area: draggable, with the page title and actions.
export function Toolbar({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="toolbar">
      <div className="title">
        <h1>{title}</h1>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="spacer" />
      {children}
      <NotificationBell />
    </header>
  );
}
