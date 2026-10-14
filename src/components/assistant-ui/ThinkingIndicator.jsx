import React from 'react';

// Copied from assistant-ui Elements; Tailwind styles translated into styles.css.
// https://www.assistant-ui.com/elements/thinking-indicator
export function ThinkingIndicator({ label, elapsed, className = '', ...props }) {
  return <div data-slot="thinking-indicator" className={`thinking-indicator ${className}`} {...props}>
    <span className="thinking-indicator-dot" aria-hidden="true" />
    <span key={label} className="thinking-indicator-label">{label}</span>
    {elapsed !== undefined && <span className="thinking-indicator-elapsed">{elapsed}</span>}
  </div>;
}
