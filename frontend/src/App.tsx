import { useState } from 'react';
import './index.css';
import { ChatInterface } from './components/ChatInterface';
import { ResearchPortal } from './components/ResearchPortal';

export type TokenStats = {
  payloadBytes: number;
  tokensPerSecond: number;
  timeToFirstTokenStart: number | null;
  timeToFirstTokenMs: number | null;
  totalTokens: number;
  totalTimeMs: number;
};

export const initialStats: TokenStats = {
  payloadBytes: 0,
  tokensPerSecond: 0,
  timeToFirstTokenStart: null,
  timeToFirstTokenMs: null,
  totalTokens: 0,
  totalTimeMs: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'research'>('chat');

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="nav-brand">
          <div className="nav-brand-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="nav-brand-name">TokenWire</span>
        </div>

        <div className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'chat' ? 'nav-tab--active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          <button
            className={`nav-tab ${activeTab === 'research' ? 'nav-tab--active-cyan' : ''}`}
            onClick={() => setActiveTab('research')}
          >
            Research
          </button>
        </div>
      </nav>

      <div className="app-content">
        {activeTab === 'chat' ? <ChatInterface /> : <ResearchPortal />}
      </div>
    </div>
  );
}
